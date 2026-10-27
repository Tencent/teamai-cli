/**
 * Judge work for workflow passes (#1085). Nothing is queued: open work is computed from the run files, the scorers each
 * run pinned, the label store and the attempt store on every `teamai score --next`. The engine never calls this module,
 * and this module never writes a run file, so scoring cannot move a run's counts, tokens, failure or end time.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DriverSchema, driverIdentity, sameDriver } from '../driver-identity.js';
import type { LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';
import { warnOnce } from '../utils/warn-once.js';
import {
  AttemptStore, isRunAttempt, newAttemptId, rawOutputPath, scoresDir, type AttemptRecord, type JudgeDriver, type JudgeFailureCode, type LeasedAttempt, type LeasedRunAttempt,
  type LeasedSessionAttempt, type RunAttempt, type ScoreRequest, type SessionAttempt, type SucceededAttempt,
} from '../scorers/attempts.js';
import { batchesScorers, JudgeAnswerSchema, verdictsOf } from '../scorers/batch.js';
import { cachedScorerNames, pinScorers } from '../scorers/cache.js';
import { pinnedDefinition, type PinnedScorer } from '../scorers/pin.js';
import type { ScorerDefinition } from '../scorers/definition.js';
import {
  ENTRY_WINDOW_MS, LEASE_TTL_MS, entryIdOf, entryState, hasLapsed, leaseRefOf, liveSessionLease, parseLeaseRef, type EntryState,
} from '../scorers/entry.js';
import { observedEffort, observedModel } from '../agent-observation.js';
import {
  ACCESS_LEVELS, ISOLATIONS, JudgeUsageSchema, sumUsage, type Isolation, type JudgeAccess, type JudgeUsage, type RunSubject, type ScoreLabel, type SessionLabel,
  type SessionSubject,
} from '../scorers/label.js';
import { LabelStore, reasoningPath, shareFailedLabelHint } from '../scorers/label-store.js';
import { installedJudgeTools, isJudgeTool, runLocalJudge } from '../scorers/judge.js';
import { JUDGE_TOOLS } from '../tool-launch/tools.js';
import { loadModelAliases } from '../models/aliases.js';
import { chooseJudgeModel } from '../scorers/judge-model.js';
import { isSampled } from '../scorers/sampling.js';
import { scoringUnavailable } from '../scorers/home.js';
import { requiredIsolation, scorerIsolationSource, unknownIsolationText, type IsolationSetting } from '../scorers/isolation.js';
import { scopeScoring } from '../scorers/settings.js';
import { answerSchema, evidenceDirOf, sweepEvidence, type Rubrics } from '../scorers/evidence.js';
import { agreedRunMode } from '../launch-context.js';
import { sessionLabel, SessionWork, writeSessionEvidence, type JudgedSession, type NamedSession, type SessionEntry } from '../session-flow/session-work.js';
import { buildEvidence, evidencePlan } from './scoring-evidence.js';
import { error, ok } from './engine.js';
import { firstSettled, passesWithin, runPasses, type RunPass } from './loop.js';
import { stepDefinitions } from './scope.js';
import { agentPassOf, agentSucceeded } from './step-state.js';
import { parseStepPath } from './step-path.js';
import { installOwner, isRunId, readRun, runsDir } from './store.js';
import type { InlineWorkflow, RunState, WorkflowDefinition, WorkflowEnvelope, WorkflowStep } from './types.js';

/** A succeeded pass of a step that lists scorers this run pinned. */
interface ScorablePass {
  subject: RunSubject;
  scorers: string[];
}

/** Whether this install settled `pass`: its stamp, or, for a pass settled before stamps, a run no other install handed over. */
export function settledHere(run: RunState, pass: RunPass, install: string): boolean {
  return pass.installId === undefined ? run.publication === undefined : pass.installId === install;
}

/**
 * The passes a judge can judge: passes of prompt and workflow steps whose agent succeeded, delivering or not, and of a
 * `for_each` step only its items.
 */
function judgeablePasses(run: RunState): Array<{ pass: RunPass; definition: WorkflowStep }> {
  const definitionOf = stepDefinitions(run);
  return runPasses(run, agentPassOf).flatMap((pass) => {
    const definition: WorkflowStep | undefined = definitionOf(pass.step);
    if (!agentSucceeded(pass) || !definition) return [];
    if (definition.forEach && parseStepPath(pass.step).at(-1)?.index === undefined) return [];
    return [{ pass, definition }];
  });
}

/**
 * The passes of `run` this install may judge: judgeable passes of steps that list a scorer the run pinned. A prompt pass
 * belongs to the install that settled it; a workflow pass to the install that settled its first child that has a
 * stamp. Sampling is left to the caller.
 */
export function scoredPasses(run: RunState, install: string): ScorablePass[] {
  const all = runPasses(run, agentPassOf);
  const pinned = run.scorers ?? {};
  return judgeablePasses(run).flatMap(({ pass, definition }) => {
    const scorers = (definition.scorers?.names ?? []).filter((name) => Object.hasOwn(pinned, name));
    if (scorers.length === 0) return [];
    const owner = definition.workflow === undefined ? pass
      : firstSettled(passesWithin(run, all, pass.step, pass.pass).filter((child) => child.installId !== undefined));
    if (!settledHere(run, owner ?? pass, install)) return [];
    return [{ subject: { runId: run.id, step: pass.step, pass: pass.pass }, scorers }];
  });
}

/** What a driver says when it asks for judge work. */
export interface JudgeRequest {
  driver: JudgeDriver;
  /** `access` is what the driver's judge can do beyond answering; a driver that does not say counts as `full`. */
  judge: { isolation: Isolation; access?: JudgeAccess; tools: [string, ...string[]] };
  /** The lease refs the driver is still running; each is renewed. A live lease of this driver it leaves out is handed back. */
  running: string[];
  /**
   * On demand, only this work, whatever sampling says: the passes of these entry ids, or the scorers an explicit
   * `score --session` request names on one session, whatever the background filters say.
   */
  entries?: { source: 'workflow'; ids: readonly string[] } | ({ source: 'session' } & NamedSession);
  /** Only the workflow work of this run, never a session: a driver that judges the run it drives. */
  run?: string;
  /** `session`: only finished sessions, as the background driver judges. Else workflow work first, then sessions. */
  only?: 'session';
  /** False: renew the leases in `running` and take nothing, neither a new lease nor one handed back. */
  canTakeLease?: boolean;
}

const NextPayloadSchema = z.object({
  driver: DriverSchema.extend({
    can: z.object({
      judge: z.object({ isolation: z.enum(ISOLATIONS), access: z.enum(ACCESS_LEVELS).optional(), tools: z.array(z.string().min(1)).nonempty() }, {
        required_error: 'driver.can.judge is required: {"isolation":"verified" or "best-effort","tools":["claude",…]}',
      }),
    }, { required_error: 'driver.can.judge is required: {"isolation":"verified" or "best-effort","tools":["claude",…]}' }),
  }),
  running: z.array(z.string()).default([]),
  run: z.string().min(1).optional(),
  canTakeLease: z.boolean().optional(),
});

const SubmitPayloadSchema = z.object({
  driver: DriverSchema,
  outcome: z.enum(['success', 'failed', 'released']),
  answer: JudgeAnswerSchema.optional(),
  judge: z.object({ tool: z.string().min(1).optional(), model: z.string().min(1).optional(), usage: JudgeUsageSchema.optional(), isolation: z.enum(ISOLATIONS).optional() }).optional(),
});
type SubmitPayload = z.infer<typeof SubmitPayloadSchema>;
export type JudgeSubmission =
  | { driver: JudgeDriver; outcome: 'success'; answer: NonNullable<SubmitPayload['answer']>; judge?: SubmitPayload['judge'] }
  | { driver: JudgeDriver; outcome: 'released' | 'failed'; judge?: SubmitPayload['judge'] };

function issueText(issues: z.ZodIssue[]): string {
  const issue = issues[0];
  if (!issue) return 'is not valid';
  return `${issue.path.join('.') || 'payload'}: ${issue.message}`;
}

export function parseJudgeRequest(value: unknown): JudgeRequest | string {
  const parsed = NextPayloadSchema.safeParse(value);
  if (!parsed.success) return issueText(parsed.error.issues);
  const { can, ...driver } = parsed.data.driver;
  const { running, run, canTakeLease } = parsed.data;
  return { driver, judge: can.judge, running, ...(run !== undefined ? { run } : {}), ...(canTakeLease !== undefined ? { canTakeLease } : {}) };
}

export function parseJudgeSubmission(value: unknown): JudgeSubmission | string {
  const parsed = SubmitPayloadSchema.safeParse(value);
  if (!parsed.success) return issueText(parsed.error.issues);
  const { outcome, answer, ...submission } = parsed.data;
  if (outcome !== 'success') return { ...submission, outcome };
  return answer ? { ...submission, outcome, answer } : 'answer: a success needs answer.label and answer.reasoning, or one of those per scorer of a batch';
}

/** One sampled (scorer, pass) with its derived state. */
interface RunEntry {
  source: 'workflow';
  id: string;
  run: RunState;
  scorer: string;
  pin: PinnedScorer;
  definition: ScorerDefinition;
  subject: RunSubject;
  state: EntryState;
  /** Whether the step's scorers share one judge call. */
  batch: boolean;
  /** When a member last asked for this entry with `teamai score --run`. */
  requestedAt?: string;
}

/** Judge work of either source: a workflow pass, or a finished session (`session-flow/session-work.ts`). */
type ScoreEntry = RunEntry | SessionEntry;

/** Every readable run of this scope, oldest first. */
export async function localRuns(config: LocalConfig): Promise<RunState[]> {
  const files = await fs.readdir(runsDir(config)).catch(() => []);
  const ids = files.filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -'.json'.length)).filter(isRunId);
  const runs = await Promise.all(ids.map((id) => readRun(config, id)));
  return runs.filter((run): run is RunState => typeof run === 'object').sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** The runs a judge may still be asked about: running ones, those `kept` names, and those changed inside the entry window. */
async function recentRuns(config: LocalConfig, now: string, kept: ReadonlySet<string>): Promise<RunState[]> {
  return (await localRuns(config))
    .filter((run) => run.status === 'running' || kept.has(run.id) || Date.parse(run.updatedAt) + ENTRY_WINDOW_MS > Date.parse(now));
}

function sameSubject(label: ScoreLabel, scorer: string, sourceHash: string, subject: RunSubject): boolean {
  return label.source === 'workflow' && label.scorer === scorer && label.rubric.sourceHash === sourceHash
    && label.subject.runId === subject.runId && label.subject.step === subject.step && label.subject.pass === subject.pass;
}

/** `defaults.scorers.batch` in effect at a step: that of the workflow file it is in, else of the one around that. */
function workflowBatch(run: RunState, step: string): boolean | undefined {
  let workflow: WorkflowDefinition | InlineWorkflow | undefined = run.definition;
  let batch = run.definition.defaults?.scorers?.batch;
  for (const { id } of parseStepPath(step).slice(0, -1)) {
    const parent: WorkflowStep | undefined = workflow?.steps.find((candidate) => candidate.id === id);
    if (typeof parent?.workflow === 'string') {
      const named: WorkflowDefinition | undefined = run.workflows?.[parent.workflow];
      batch = named?.defaults?.scorers?.batch ?? batch;
      workflow = named;
    } else {
      workflow = parent?.workflow;
    }
  }
  return batch;
}

/** The sampled entries of each recent run, and the ones a member asked for, which replace a sampled one of the same id. */
async function scoreEntries(config: LocalConfig, now: string, teamBatch: boolean | undefined): Promise<RunEntry[]> {
  const install = (await installOwner(config)).id;
  const [labels, attempts, requests] = await Promise.all([LabelStore.local(config), AttemptStore.read(config), AttemptStore.requests(config)]);
  const kept = new Set([
    ...[...attempts.values()].flat().filter(isRunAttempt).filter((attempt) => attempt.status === 'leased' && !hasLapsed(attempt, now)).map((attempt) => attempt.subject.runId),
    ...requests.map((request) => request.subject.runId),
  ]);
  const runs = await recentRuns(config, now, kept);
  return runs.flatMap((run) => {
    const entryOf = (scorer: string, pin: PinnedScorer, subject: RunSubject, request?: ScoreRequest): RunEntry[] => {
      const definition = pinnedDefinition(scorer, pin);
      if (!definition) return [];
      const id = entryIdOf(scorer, subject);
      const state = entryState({
        labels: labels.filter((label) => sameSubject(label, scorer, pin.sourceHash, subject)),
        attempts: attempts.get(id) ?? [],
        subjectChangedAt: run.updatedAt,
        ...(request ? { requestedAt: request.requestedAt } : {}),
        now,
      });
      const batch = request?.batch ?? batchesScorers({ step: stepDefinitions(run)(subject.step)?.scorers?.batch, workflow: workflowBatch(run, subject.step), team: teamBatch });
      return [{ source: 'workflow', id, run, scorer, pin, definition, subject, state, batch, ...(request ? { requestedAt: request.requestedAt } : {}) }];
    };
    const requested = requests.filter((request) => request.subject.runId === run.id)
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt) || left.scorer.localeCompare(right.scorer))
      .flatMap((request) => entryOf(request.scorer, request.pin, request.subject, request));
    const sampled = scoredPasses(run, install).flatMap(({ subject, scorers }) => scorers.flatMap((scorer) => {
      const pin = run.scorers?.[scorer];
      const definition = pin && pinnedDefinition(scorer, pin);
      if (!pin || !definition || !isSampled(scorer, subject, definition.samplingRate)) return [];
      return entryOf(scorer, pin, subject);
    }));
    return [...sampled.filter((entry) => !requested.some((request) => request.id === entry.id)), ...requested];
  });
}

function requiredFor(settings: readonly IsolationSetting[], { scorer, pin, definition }: Pick<ScoreEntry, 'scorer' | 'pin' | 'definition'>): Isolation {
  return requiredIsolation([...settings, { source: scorerIsolationSource(scorer, pin.relativePath), value: definition.isolation }]).level;
}

/**
 * The scorers among `names` whose judge must be `verified` here, as the team, the scorer and this machine ask; or why
 * this scope's scoring settings cannot be read. A scorer is read as `pinned` holds it, such as a run's, else as cached now.
 */
export async function verifiedScorers(config: LocalConfig, names: readonly string[], pinned?: Record<string, PinnedScorer>): Promise<{ ok: true; scorers: string[] } | { ok: false; reason: string }> {
  const scoring = await scopeScoring(config);
  if (!scoring.ok) return scoring;
  const pins = Object.entries(pinned ?? await pinScorers(config, names)).filter(([scorer]) => names.includes(scorer));
  return { ok: true, scorers: pins.flatMap(([scorer, pin]) => {
    const definition = pinnedDefinition(scorer, pin);
    return definition && requiredFor(scoring.isolation, { scorer, pin, definition }) === 'verified' ? [scorer] : [];
  }) };
}

/** Whether a judge at `offered` isolation may judge for a scorer that asks for `required`. */
function meets(offered: Isolation, required: Isolation): boolean {
  return ISOLATIONS.indexOf(offered) >= ISOLATIONS.indexOf(required);
}

/** Whether the driver still offers what `attempt` was leased with: its tool, at its isolation or stricter. */
function stillJudges(request: JudgeRequest, attempt: LeasedAttempt): boolean {
  return request.judge.tools.includes(attempt.judge.tool) && meets(request.judge.isolation, attempt.judge.isolation);
}

/** A batch member still leased while another scorer of its lease settled or was never written: a write was interrupted. */
async function isStranded(config: LocalConfig, attempt: LeasedAttempt): Promise<boolean> {
  const peers = await Promise.all((attempt.batch ?? []).map((entry) => AttemptStore.get(config, entry, attempt.attempt)));
  return peers.some((peer) => peer?.status !== 'leased');
}

function evidenceDir(config: LocalConfig, attempt: string): string {
  return evidenceDirOf(scoresDir(config), attempt);
}

/** A lease's attempts, one per scorer it judges, in the step's order; the first one's ref is the lease's. */
type Members = readonly [Member, ...Member[]];
interface Member {
  entry: RunEntry;
  attempt: LeasedRunAttempt;
}
type SessionMembers = readonly [SessionMember, ...SessionMember[]];
interface SessionMember {
  entry: SessionEntry;
  attempt: LeasedSessionAttempt;
}

/** A lease being handed out. A batch has one source; a session lease is never handed back. */
type Lease = { source: 'workflow'; members: Members; handedBack: boolean } | { source: 'session'; members: SessionMembers };

/** The directory a lease's submit runs in, so its teamai resolves to the data home that holds the lease. */
function leaseCwdOf(config: LocalConfig, lease: Lease): string | undefined {
  switch (lease.source) {
    case 'workflow':
      return lease.members[0].entry.run.checkout;
    case 'session':
      return SessionWork.leaseCwd(config);
    default: {
      const unhandled: never = lease;
      return unhandled;
    }
  }
}

function rubricOf(pin: PinnedScorer): { sourceHash: string; teamRevision?: string } {
  return { sourceHash: pin.sourceHash, ...(pin.teamRevision ? { teamRevision: pin.teamRevision } : {}) };
}

/** What a lease keeps of `pin`: the revision and file it came from. Its text is kept by hash. */
function sourceOf({ content: _content, ...source }: PinnedScorer): LeasedAttempt['rubric'] {
  return source;
}

/** The rubric `attempt` was leased with: the text kept by its hash, pinned from the file and revision the attempt names. */
async function leasedRubric(config: LocalConfig, attempt: AttemptRecord): Promise<{ pin: PinnedScorer; definition: ScorerDefinition } | undefined> {
  const kept = await AttemptStore.rubric(config, attempt.rubric.sourceHash);
  const pin = kept && { ...attempt.rubric, content: kept.content };
  const definition = pin && pinnedDefinition(attempt.scorer, pin);
  return pin && definition ? { pin, definition } : undefined;
}

function rubricsOf<T>(members: readonly [T, ...T[]], definitionOf: (member: T) => ScorerDefinition): Rubrics {
  const [head, ...tail] = members;
  return [definitionOf(head), ...tail.map(definitionOf)];
}

async function leaseAnswer(config: LocalConfig, lease: Lease) {
  const members: readonly [Member | SessionMember, ...Array<Member | SessionMember>] = lease.members;
  const [{ entry, attempt }] = members;
  const cwd = leaseCwdOf(config, lease);
  const dir = evidenceDir(config, attempt.attempt);
  const prompt = path.join(dir, 'prompt.md');
  const ref = leaseRefOf(attempt);
  const batched = members.length > 1;
  return {
    ref,
    source: lease.source,
    ...(batched
      ? { scorers: members.map((member) => member.entry.scorer), rubrics: Object.fromEntries(members.map((member) => [member.entry.scorer, rubricOf(member.entry.pin)])) }
      : { scorer: entry.scorer, rubric: rubricOf(entry.pin) }),
    subject: attempt.subject,
    judge: attempt.judge,
    evidence: dir,
    prompt,
    answer: { schema: answerSchema(rubricsOf(members, (member) => member.entry.definition)) },
    expiresAt: attempt.expiresAt,
    ...(cwd ? { cwd } : {}),
    submit: `teamai score --lease ${ref} --submit --stdin`,
    ...(batched ? { batched: true } : {}),
    ...(lease.source === 'workflow' && lease.handedBack ? { handedBack: true } : {}),
  };
}

function later(now: string, ms: number): string {
  return new Date(Date.parse(now) + ms).toISOString();
}

function sameChoice(left: JudgeChoice, right: JudgeChoice): boolean {
  return left.tool === right.tool && left.model?.name === right.model?.name && left.model?.effort === right.model?.effort;
}

type JudgeChoice = Pick<LeasedAttempt['judge'], 'tool' | 'model' | 'by' | 'noModel'>;

interface ClosedEntry {
  ref: string;
  code: string;
}

/** Work none of this driver's tools can run the scorer's model for, left open for a driver whose tools can. */
export interface SkippedEntry {
  scorer: string;
  subject: RunSubject | SessionSubject;
  code: 'judge_model_unavailable';
  message: string;
}

type OneLease =
  | { kind: 'lease'; lease: Awaited<ReturnType<typeof leaseAnswer>>; skipped: SkippedEntry[] }
  | { kind: 'idle'; open: number; leased: number; skipped: SkippedEntry[] };

/** `busy`: another process holds the attempts lock. */
export type TakenLease = (OneLease & { closed: ClosedEntry[] }) | { kind: 'busy' };

/**
 * The one way to get judge work; `workflow next` never hands it out. Releases a live lease of this driver that it no
 * longer offers the tool or isolation for, or whose kept rubric is gone, renews the leases it lists in `running`, and
 * with `canTakeLease: false` stops there. Else it hands back one it left out with the rubric it was taken with, else
 * leases the first open entry, oldest run first, whose isolation the driver meets. When its step batches scorers, the
 * other open entries of the same pass that resolve to the same tool and model join that lease. Answers `idle` with
 * counts when there is none. An entry whose evidence is empty closes, and the next one is tried. An entry whose scorer's
 * model none of the driver's tools runs is skipped and stays open for another driver. With `entries` of a named
 * session, it leases that session's scorers whole, whatever the background filters and the daily limit say, while no
 * live lease holds any of them; an empty evidence closes them and answers `idle`.
 */
export async function takeJudgeLease(config: LocalConfig, request: JudgeRequest, now: string): Promise<TakenLease> {
  const earlier: ClosedEntry[] = [];
  for (;;) {
    const taken = await takeOneLease(config, request, now);
    switch (taken.kind) {
      case 'evidence_empty':
        earlier.push(...taken.closed);
        // A named session is open again after a failed attempt, so reading it again would fail again.
        if (request.entries?.source === 'session') return { kind: 'idle', open: 0, leased: 0, skipped: [], closed: earlier };
        break;
      case 'raced':
        break;
      case 'lease':
      case 'idle':
        return { ...taken, closed: earlier };
      case 'busy':
        return taken;
      default: {
        const unhandled: never = taken;
        return unhandled;
      }
    }
  }
}

/** The named session `entries` asks for, or the workflow entry ids it keeps to; neither when it asks for no entries. */
function entrySources(entries: JudgeRequest['entries']): { named?: NamedSession; ids?: readonly string[] } {
  if (entries === undefined) return {};
  switch (entries.source) {
    case 'workflow':
      return { ids: entries.ids };
    case 'session':
      return { named: entries };
    default: {
      const unhandled: never = entries;
      return unhandled;
    }
  }
}

/**
 * What the attempts lock decided: a lease, an unreadable session that closed, nothing to lease, or `raced`: the session
 * to lease is not the one read before the lock, since another driver took that one meanwhile.
 */
type LockedLease =
  | { kind: 'workflow'; members: Members; handedBack: boolean }
  | { kind: 'session'; members: SessionMembers; judged: JudgedSession }
  | { kind: 'evidence_empty'; closed: ClosedEntry[] }
  | { kind: 'raced' }
  | { kind: 'none' };

/**
 * The judge entries of `config` that `request` names, and whether the day's session launches are spent, after warning
 * of what in the scoring settings is off; undefined while scoring is unavailable here.
 */
async function requestedEntries(config: LocalConfig, request: Pick<JudgeRequest, 'only' | 'entries' | 'run'>, now: string) {
  const unavailable = scoringUnavailable(config);
  if (unavailable) {
    log.warn(unavailable);
    return undefined;
  }
  // A drain asks once for each lease it takes: what is off in the team's settings is said once a run.
  const scoring = await scopeScoring(config);
  if (!scoring.ok) {
    warnOnce(scoring.reason);
    return undefined;
  }
  const { named, ids } = entrySources(request.entries);
  const all = request.only === 'session' || named ? [] : await scoreEntries(config, now, scoring.batch);
  const runs = all.filter((entry) => (!ids || ids.includes(entry.id)) && (request.run === undefined || entry.subject.runId === request.run));
  const { entries: sessions, captured } = named ? { entries: await SessionWork.entriesOf(config, named, now), captured: undefined }
    : request.entries || request.run !== undefined ? { entries: [], captured: undefined } : await SessionWork.entries(config, now, scoring);
  for (const unknown of requiredIsolation(scoring.isolation).unknown) warnOnce(`${unknownIsolationText(unknown)}.`);
  for (const problem of scoring.problems) warnOnce(`${problem}.`);
  const limited = !named && sessions.length > 0 && SessionWork.launchesToday([...(await AttemptStore.read(config)).values()].flat(), now) >= scoring.sessions.dailyLimit;
  return { scoring, all, runs, sessions, captured, limited, named: named !== undefined };
}

/**
 * Whether `entry` is open judge work. A pass released under the attempts lock is open again; a session is judged once,
 * so a release closes it unless the request named it, and none is open while the day's session launches are spent
 * (`limited`).
 */
function isOpenEntry(entry: ScoreEntry, { limited, released, named }: { limited: boolean; released: ReadonlySet<string>; named: boolean }): boolean {
  switch (entry.source) {
    case 'workflow':
      return entry.state.kind === 'open' || released.has(entry.id);
    case 'session':
      // A named session's lease this driver gave up under this lock leaves it open again.
      return (entry.state.kind === 'open' || (named && released.has(entry.id))) && !limited;
    default: {
      const unhandled: never = entry;
      return unhandled;
    }
  }
}

/** How many judge entries of `config` are open, as the idle answer of `takeJudgeLease` counts them, with no lock or write. */
export async function openJudgeEntries(config: LocalConfig, now: string): Promise<number> {
  const requested = await requestedEntries(config, {}, now);
  if (!requested) return 0;
  const { runs, sessions, limited } = requested;
  return [...runs, ...sessions].filter((entry) => isOpenEntry(entry, { limited, released: new Set(), named: false })).length;
}

async function takeOneLease(config: LocalConfig, request: JudgeRequest, now: string): Promise<OneLease | { kind: 'busy' } | { kind: 'evidence_empty'; closed: ClosedEntry[] } | { kind: 'raced' }> {
  const requested = await requestedEntries(config, request, now);
  if (!requested) return { kind: 'idle', open: 0, leased: 0, skipped: [] };
  const { scoring, all, runs, sessions, captured, named } = requested;
  const found: ScoreEntry[] = [...runs, ...sessions];
  const { dailyLimit } = scoring.sessions;
  const aliases = await loadModelAliases(config);
  const { isolation } = scoring;
  const skipped: SkippedEntry[] = [];
  const released = new Set<string>();
  // Whether the day's session launches are spent: then no session is open, until the next local day.
  let { limited } = requested;
  const isOpen = (entry: ScoreEntry): boolean => isOpenEntry(entry, { limited, released, named });
  const leasable = (entry: ScoreEntry) => isOpen(entry) && meets(request.judge.isolation, requiredFor(isolation, entry));
  const judges = (entry: ScoreEntry) => leasable(entry) && chooseJudgeModel(aliases, entry.definition, request.judge.tools).ok;
  const running = new Set(request.running.flatMap((ref) => parseLeaseRef(ref)?.attempt ?? []));
  // A session is read before the lock, which a slow read must not hold: the first one this lock would lease.
  const next = request.canTakeLease === false || runs.some(judges) ? undefined : sessions.find(judges);
  const prepared = next && { entry: next, read: await SessionWork.read(config, next.subject) };
  const outcome = await AttemptStore.locked(config, async (): Promise<LockedLease> => {
    for (const entry of all) {
      if (entry.requestedAt !== undefined && entry.state.kind !== 'open' && entry.state.kind !== 'leased') await AttemptStore.closeRequest(config, entry.id, entry.requestedAt);
    }
    await AttemptStore.sweep(config);
    if (captured) {
      const attempts = await AttemptStore.read(config);
      for (const entry of SessionWork.gone(attempts, captured, now)) {
        // Evidence first: an attempt is the only record that names it, and a crash in between leaves both to retry.
        await sweepEvidence(scoresDir(config), new Set((attempts.get(entry) ?? []).map((attempt) => attempt.attempt)));
        await AttemptStore.removeEntry(config, entry);
      }
    }
    // Re-read under the lock: another driver may have taken an entry since the unlocked read.
    const isFresh = async (entry: RunEntry) =>
      entryState({ labels: [], attempts: await AttemptStore.ofEntry(config, entry.id), subjectChangedAt: entry.run.updatedAt, requestedAt: entry.requestedAt, now }).kind === 'open';
    const mine = new Map<string, Members>();
    for (const entry of found) {
      const live = (await AttemptStore.ofEntry(config, entry.id))
        .find((attempt): attempt is LeasedAttempt => attempt.status === 'leased' && !hasLapsed(attempt, now));
      if (!live) continue;
      if (await isStranded(config, live)) {
        await AttemptStore.write(config, { ...live, status: 'released', settledAt: now });
        released.add(entry.id);
        continue;
      }
      if (!sameDriver(live.driver, request.driver)) continue;
      const rubric = await leasedRubric(config, live);
      if (!rubric || !stillJudges(request, live)) {
        await AttemptStore.write(config, { ...live, status: 'released', settledAt: now });
        released.add(entry.id);
      } else if (running.has(live.attempt)) {
        await AttemptStore.write(config, { ...live, expiresAt: later(now, LEASE_TTL_MS) });
      } else if (entry.source === 'workflow' && isRunAttempt(live)) {
        // A session lease left out is left alone: it lapses, and the session is not judged again.
        const member = { entry: { ...entry, ...rubric }, attempt: live };
        const lease = mine.get(live.attempt);
        mine.set(live.attempt, lease ? [...lease, member] : [member]);
      }
    }
    const [back] = mine.values();
    if (request.canTakeLease === false) return { kind: 'none' };
    if (back) return { kind: 'workflow', members: back, handedBack: true };
    // A session key is leased once: still untried, while the day has launches left, and only as read before the lock. A
    // named one is leased while no live lease holds it.
    const isFree = async (entry: SessionEntry) => {
      const attempts = await AttemptStore.ofEntry(config, entry.id);
      return named ? liveSessionLease(attempts, now) === undefined : attempts.length === 0 && !await SessionWork.isLabelled(config, entry);
    };
    const leaseSession = async (entry: SessionEntry): Promise<LockedLease | undefined> => {
      if (!leasable(entry) || !await isFree(entry)) return undefined;
      const chosen = chooseJudgeModel(aliases, entry.definition, request.judge.tools);
      if (!chosen.ok) {
        skipped.push({ scorer: entry.scorer, subject: entry.subject, code: chosen.code, message: chosen.message });
        return undefined;
      }
      if (!named && SessionWork.launchesToday([...(await AttemptStore.read(config)).values()].flat(), now) >= dailyLimit) {
        limited = true;
        return { kind: 'none' };
      }
      if (prepared?.entry.id !== entry.id) return { kind: 'raced' };
      const mates: Array<{ entry: SessionEntry; choice: JudgeChoice }> = [];
      for (const other of entry.batch ? sessions : []) {
        if (other === entry || other.subject.platform !== entry.subject.platform || other.subject.sessionId !== entry.subject.sessionId) continue;
        const choice = chooseJudgeModel(aliases, other.definition, request.judge.tools);
        if (choice.ok && sameChoice(choice.choice, chosen.choice) && leasable(other) && await isFree(other)) mates.push({ entry: other, choice: choice.choice });
      }
      // A named session is leased whole: a scorer another lease holds keeps the rest waiting for it.
      if (named && mates.length < sessions.length - 1) return { kind: 'none' };
      const attempt = newAttemptId();
      const tried = [{ entry, choice: chosen.choice }, ...mates];
      const batch = mates.length > 0 ? tried.map((member) => member.entry.id) : undefined;
      const taken = ({ entry: member, choice }: (typeof tried)[number]) => ({
        attempt,
        entry: member.id,
        scorer: member.scorer,
        rubric: sourceOf(member.pin),
        source: 'session' as const,
        subject: member.subject,
        driver: request.driver,
        judge: { ...choice, isolation: request.judge.isolation, access: request.judge.access ?? 'full' },
        leasedAt: now,
        expiresAt: later(now, LEASE_TTL_MS),
        ...(batch ? { batch } : {}),
      });
      if (!prepared.read.ok) {
        for (const member of tried) await AttemptStore.write(config, { ...taken(member), status: 'failed', code: 'evidence_empty', settledAt: now });
        return { kind: 'evidence_empty', closed: tried.map((member) => ({ ref: leaseRefOf({ entry: member.entry.id, attempt }), code: 'evidence_empty' })) };
      }
      const { judged } = prepared.read;
      const leased = (member: (typeof tried)[number]): SessionMember => ({ entry: member.entry, attempt: { ...taken(member), status: 'leased', session: judged.context } });
      const members: SessionMembers = [leased(tried[0]), ...mates.map(leased)];
      for (const member of members) await AttemptStore.keepRubric(config, member.entry.pin);
      for (const member of members) await AttemptStore.write(config, member.attempt);
      return { kind: 'session', members, judged };
    };
    for (const entry of found) {
      if (entry.source === 'session') {
        const taken = await leaseSession(entry);
        if (taken) return taken;
        continue;
      }
      if (!leasable(entry) || !await isFresh(entry)) continue;
      const chosen = chooseJudgeModel(aliases, entry.definition, request.judge.tools);
      const attempt = newAttemptId();
      const leased = (member: RunEntry, choice: JudgeChoice, batch?: string[]): LeasedRunAttempt => ({
        status: 'leased',
        attempt,
        entry: member.id,
        scorer: member.scorer,
        rubric: sourceOf(member.pin),
        subject: member.subject,
        driver: request.driver,
        judge: { ...choice, isolation: request.judge.isolation, access: request.judge.access ?? 'full' },
        leasedAt: now,
        expiresAt: later(now, LEASE_TTL_MS),
        ...(batch ? { batch } : {}),
      });
      if (!chosen.ok) {
        skipped.push({ scorer: entry.scorer, subject: entry.subject, code: chosen.code, message: chosen.message });
        continue;
      }
      const mates: Array<{ entry: RunEntry; choice: JudgeChoice }> = [];
      for (const other of entry.batch ? runs : []) {
        if (other === entry || other.subject.runId !== entry.subject.runId || other.subject.step !== entry.subject.step || other.subject.pass !== entry.subject.pass) continue;
        const choice = chooseJudgeModel(aliases, other.definition, request.judge.tools);
        if (choice.ok && sameChoice(choice.choice, chosen.choice) && leasable(other) && await isFresh(other)) mates.push({ entry: other, choice: choice.choice });
      }
      const batch = mates.length > 0 ? [entry.id, ...mates.map((mate) => mate.entry.id)] : undefined;
      const members: Members = [{ entry, attempt: leased(entry, chosen.choice, batch) }, ...mates.map((mate) => ({ entry: mate.entry, attempt: leased(mate.entry, mate.choice, batch) }))];
      for (const member of members) await AttemptStore.keepRubric(config, member.entry.pin);
      for (const member of members) await AttemptStore.write(config, member.attempt);
      return { kind: 'workflow', members, handedBack: false };
    }
    return { kind: 'none' };
  });
  if (outcome.status === 'busy') return { kind: 'busy' };
  const leased = outcome.value;
  const attempts = await AttemptStore.read(config);
  await sweepEvidence(scoresDir(config), new Set([...attempts.values()].flat()
    .filter((attempt) => attempt.status !== 'leased' || hasLapsed(attempt, now)).map((attempt) => attempt.attempt)));
  switch (leased.kind) {
    case 'workflow': {
      const [{ entry, attempt }] = leased.members;
      const built = await buildEvidence(config, entry.run, entry.subject, rubricsOf(leased.members, (member) => member.entry.definition), evidenceDir(config, attempt.attempt));
      if (!built.ok) {
        const failed = await AttemptStore.locked(config, async () => {
          for (const member of leased.members) {
            const current = await AttemptStore.get(config, member.attempt.entry, member.attempt.attempt);
            if (current?.status === 'leased') await AttemptStore.write(config, { ...current, status: 'failed', code: built.code, settledAt: now });
          }
        });
        if (failed.status === 'busy') return { kind: 'busy' };
        await fs.rm(evidenceDir(config, attempt.attempt), { recursive: true, force: true, maxRetries: 3 });
        return { kind: 'evidence_empty', closed: leased.members.map((member) => ({ ref: leaseRefOf(member.attempt), code: built.code })) };
      }
      return { kind: 'lease', lease: await leaseAnswer(config, { source: 'workflow', members: leased.members, handedBack: leased.handedBack }), skipped };
    }
    case 'session': {
      await writeSessionEvidence(evidenceDir(config, leased.members[0].attempt.attempt), leased.judged, rubricsOf(leased.members, (member) => member.entry.definition));
      return { kind: 'lease', lease: await leaseAnswer(config, { source: 'session', members: leased.members }), skipped };
    }
    case 'evidence_empty':
    case 'raced':
      return leased;
    case 'none':
      return {
        kind: 'idle',
        open: found.filter(isOpen).length,
        leased: found.filter((entry) => entry.state.kind === 'leased' && !released.has(entry.id)).length,
        skipped,
      };
    default: {
      const unhandled: never = leased;
      return unhandled;
    }
  }
}

/**
 * `teamai score --next`: the lease `takeJudgeLease` took, or `idle` with counts, the entries that closed meanwhile, and
 * why the driver's tools cannot judge the ones it skipped.
 */
export async function nextJudgeLease(config: LocalConfig, request: JudgeRequest, now = new Date().toISOString()): Promise<WorkflowEnvelope> {
  const taken = await takeJudgeLease(config, request, now);
  switch (taken.kind) {
    case 'lease':
      return ok({ lease: taken.lease, ...(taken.closed.length ? { closed: taken.closed } : {}), ...(taken.skipped.length ? { skipped: taken.skipped } : {}) });
    case 'idle':
      return ok({ idle: { open: taken.open, leased: taken.leased }, ...(taken.closed.length ? { closed: taken.closed } : {}), ...(taken.skipped.length ? { skipped: taken.skipped } : {}) });
    case 'busy':
      return error('busy', 'The judge attempts are locked by another process. Ask again.');
    default: {
      const unhandled: never = taken;
      return unhandled;
    }
  }
}

/**
 * `teamai score --session <id> --scorer <name>… --json`: a lease on the scorers `request.entries` names on one session,
 * for the driver's own judge, as `score --next` hands one out. It takes nothing when a scorer asks for more isolation
 * than the driver offers, when none of its tools runs a scorer's model, when the scorers of a batch need different
 * models, or while a live lease holds any of them.
 */
export async function sessionJudgeLease(config: LocalConfig, request: JudgeRequest & { entries: { source: 'session' } & NamedSession }, now = new Date().toISOString()): Promise<WorkflowEnvelope> {
  const { scorers, subject } = request.entries;
  const scoring = await scopeScoring(config);
  if (!scoring.ok) return error('scoring_settings_invalid', scoring.reason);
  const required = requiredIsolation([...scoring.isolation, ...scorers.map(({ scorer, pin, definition }) => ({ source: scorerIsolationSource(scorer, pin.relativePath), value: definition.isolation }))]);
  if (!meets(request.judge.isolation, required.level)) {
    return error('isolation_unmet', `${required.setBy.join(' and ')} asks for ${required.level}, and this driver offers ${request.judge.isolation}. No judge work was taken.`);
  }
  const aliases = await loadModelAliases(config);
  const chosen: Array<{ scorer: string; choice: JudgeChoice }> = [];
  for (const { scorer, definition } of scorers) {
    const choice = chooseJudgeModel(aliases, definition, request.judge.tools);
    if (!choice.ok) return error('judge_model_unavailable', choice.message);
    chosen.push({ scorer, choice: choice.choice });
  }
  const [first] = chosen;
  if (first && chosen.some(({ choice }) => !sameChoice(choice, first.choice))) {
    const models = chosen.map(({ scorer, choice }) => `${scorer} ${choice.model?.name ?? `${choice.tool}'s default`}`).join(', ');
    return error('invalid_arguments', `--batch shares one judge call, and these scorers need different models: ${models}. Lease them one --scorer at a time.`);
  }
  const taken = await takeJudgeLease(config, request, now);
  switch (taken.kind) {
    case 'lease':
      return ok({ lease: taken.lease });
    case 'idle':
      return taken.closed.length > 0
        ? error('evidence_empty', `${subject.platform} session ${subject.sessionId} holds nothing to judge.`)
        : error('busy', `A live judge lease holds ${scorers.map(({ scorer }) => scorer).join(', ')} on ${subject.platform} session ${subject.sessionId}. Submit or release it, or ask again once it lapses, 30 minutes after it was taken or renewed.`);
    case 'busy':
      return error('busy', 'The judge attempts are locked by another process. Ask again.');
    default: {
      const unhandled: never = taken;
      return unhandled;
    }
  }
}

type Refusal = ReturnType<typeof error>;

type Labelled = { kind: 'labelled'; attempts: readonly SucceededAttempt[] };

/** `published`: whether the labels reached teamai-reports. */
export type SettledLease = (Labelled & { published: boolean }) | Refusal;

type Returned = { kind: 'returned'; status: 'released' | 'failed' };
type SubmittedLease = SettledLease | Returned;

function labelAnswer(config: LocalConfig, attempt: SucceededAttempt): Record<string, unknown> {
  const { label, score, passed, version } = attempt.verdict;
  return { scorer: attempt.scorer, subject: attempt.subject, label, score, passed, labelId: attempt.labelId, reasoning: reasoningPath(config, version) };
}

/** `{ label }` for a lease of one scorer, `{ labels }` in the step's order for a batch. */
function labelsAnswer(config: LocalConfig, attempts: readonly SucceededAttempt[]): Record<string, unknown> {
  const [only, ...more] = attempts;
  return only && more.length === 0 ? { label: labelAnswer(config, only) } : { labels: attempts.map((attempt) => labelAnswer(config, attempt)) };
}

/** One attempt of a lease, with the scorer its run pinned. */
interface Judged<T extends AttemptRecord = AttemptRecord> {
  attempt: T;
  pin: PinnedScorer;
  definition: ScorerDefinition;
}

type JudgedMembers<T extends AttemptRecord> = readonly [Judged<T>, ...Judged<T>[]];

/** A lease being settled: a workflow lease with the run it judges, or a session lease. */
type Settling = { source: 'workflow'; run: RunState; members: JudgedMembers<RunAttempt> } | { source: 'session'; members: JudgedMembers<SessionAttempt> };
type LeasedSettling =
  | { source: 'workflow'; run: RunState; members: JudgedMembers<LeasedRunAttempt> }
  | { source: 'session'; members: JudgedMembers<LeasedSessionAttempt> };

/** The attempts of a session lease, with the rubrics they were taken with. */
async function sessionMembers(config: LocalConfig, records: ReadonlyArray<AttemptRecord | undefined>, ref: string): Promise<Settling | Refusal> {
  const members: Array<Judged<SessionAttempt>> = [];
  for (const record of records) {
    if (record?.source !== 'session') return error('lease_unknown', `Judge lease ${ref} is not on this machine.`);
    const rubric = await leasedRubric(config, record);
    if (!rubric) return error('lease_unknown', `The rubric of scorer ${record.scorer} that judge lease ${ref} was taken with is not on this machine.`);
    members.push({ attempt: record, ...rubric });
  }
  const [head, ...tail] = members;
  return head ? { source: 'session', members: [head, ...tail] } : error('lease_unknown', `Judge lease ${ref} is not on this machine.`);
}

/**
 * The attempts of the lease `attempt` belongs to, one per scorer it judges in the step's order, with their pinned
 * scorers; or the error that says which is missing.
 */
async function leaseMembers(config: LocalConfig, attempt: AttemptRecord, ref: string): Promise<Settling | Refusal> {
  const records = await Promise.all((attempt.batch ?? [attempt.entry]).map((entry) => AttemptStore.get(config, entry, attempt.attempt)));
  if (!isRunAttempt(attempt)) return sessionMembers(config, records, ref);
  const run = await readRun(config, attempt.subject.runId);
  const members: Array<Judged<RunAttempt>> = [];
  for (const record of records) {
    if (!record || !isRunAttempt(record)) return error('lease_unknown', `Judge lease ${ref} is not on this machine.`);
    const rubric = await leasedRubric(config, record);
    if (typeof run !== 'object') return error('lease_unknown', `Run ${record.subject.runId}, which judge lease ${ref} was for, is not on this machine.`);
    if (!rubric) return error('lease_unknown', `The rubric of scorer ${record.scorer} that judge lease ${ref} was taken with is not on this machine.`);
    members.push({ attempt: record, ...rubric });
  }
  const [head, ...tail] = members;
  if (!head || typeof run !== 'object') return error('lease_unknown', `Judge lease ${ref} is not on this machine.`);
  return { source: 'workflow', run, members: [head, ...tail] };
}

function isSucceeded<T extends AttemptRecord>(member: Judged<T>): member is Judged<Extract<T, { status: 'succeeded' }>> {
  return member.attempt.status === 'succeeded';
}

function isLeased<T extends AttemptRecord>(member: Judged<T>): member is Judged<Extract<T, { status: 'leased' }>> {
  return member.attempt.status === 'leased';
}

function allLeased<T extends AttemptRecord>(members: JudgedMembers<T>): JudgedMembers<Extract<T, { status: 'leased' }>> | undefined {
  const [head, ...tail] = members;
  const leased = tail.filter(isLeased);
  return isLeased(head) && leased.length === tail.length ? [head, ...leased] : undefined;
}

/** `lease` when every one of its attempts is still leased. */
function leasedSettling(lease: Settling): LeasedSettling | undefined {
  switch (lease.source) {
    case 'workflow': {
      const members = allLeased(lease.members);
      return members && { source: 'workflow', run: lease.run, members };
    }
    case 'session': {
      const members = allLeased(lease.members);
      return members && { source: 'session', members };
    }
    default: {
      const unhandled: never = lease;
      return unhandled;
    }
  }
}

/** Settles an open lease through `settle`; a lease already labelled answers its own labels again. */
async function settleJudgeLease<T extends { kind: string }>(
  config: LocalConfig, ref: string, driver: JudgeDriver, now: string, settle: (lease: LeasedSettling) => Promise<T | Refusal>,
): Promise<T | Labelled | Refusal> {
  const parsedRef = parseLeaseRef(ref);
  if (!parsedRef) return error('lease_unknown', `${ref} is not a judge lease ref. A ref looks like s<13 hex>/a<8 hex>, as teamai score --next prints it.`);
  const known = await AttemptStore.get(config, parsedRef.entry, parsedRef.attempt);
  if (!known) return error('lease_unknown', `Judge lease ${ref} is not on this machine. Submit from the scope that leased it (the lease's cwd).`);
  const outcome = await AttemptStore.locked(config, async (): Promise<T | Labelled | Refusal> => {
    const current = await AttemptStore.get(config, parsedRef.entry, parsedRef.attempt);
    if (!current) return error('lease_unknown', `Judge lease ${ref} is not on this machine.`);
    const lease = await leaseMembers(config, current, ref);
    if (!('members' in lease)) return lease;
    const members: JudgedMembers<AttemptRecord> = lease.members;
    const [head] = members;
    if (!sameDriver(head.attempt.driver, driver)) return error('wrong_driver', `Judge lease ${ref} belongs to a different driver.`);
    const succeeded = members.filter(isSucceeded);
    if (succeeded.length === members.length) return { kind: 'labelled', attempts: succeeded.map((member) => member.attempt) };
    const settledAs = members.find((member) => member.attempt.status !== 'leased')?.attempt.status;
    const leased = leasedSettling(lease);
    if (settledAs || !leased) return error('lease_settled', `Judge lease ${ref} was already settled as ${settledAs ?? 'settled'}.`);
    if (leased.source === 'session') {
      // A lapsed lease still settles, unless a judge has labelled the session since or an explicit request leased it again.
      for (const { attempt, pin } of leased.members) {
        const live = liveSessionLease(await AttemptStore.ofEntry(config, attempt.entry), now);
        if (live && live.attempt !== attempt.attempt) {
          return error('lease_expired', `Judge lease ${ref} expired at ${attempt.expiresAt} and another lease now holds this session.`);
        }
        if (await SessionWork.isLabelled(config, { scorer: attempt.scorer, pin, subject: attempt.subject }, attempt.leasedAt)) {
          return error('lease_expired', `Judge lease ${ref} is not recorded: another judge has labelled this session since it was leased.`);
        }
      }
      return settle(leased);
    }
    const { run } = leased;
    for (const { attempt } of leased.members) {
      const requestedAt = (await AttemptStore.request(config, attempt.entry))?.requestedAt;
      const state = entryState({ labels: [], attempts: await AttemptStore.ofEntry(config, attempt.entry), subjectChangedAt: run.updatedAt, requestedAt, now });
      switch (state.kind) {
        case 'open':
          break;
        case 'labelled':
          return error('lease_expired', `Judge lease ${ref} expired at ${attempt.expiresAt} and another judge has labelled this work since.`);
        case 'leased':
          if (state.attempt.attempt !== attempt.attempt) {
            return error('lease_expired', `Judge lease ${ref} expired at ${attempt.expiresAt} and another driver now holds this work.`);
          }
          break;
        case 'failed':
          return error('entry_closed', `The judge work of lease ${ref} closed as ${state.code}, so this answer is not recorded. Run teamai score --next for open work.`);
        case 'expired':
          return error('entry_closed', `The judge work of lease ${ref} expired 14 days after its run last changed, so this answer is not recorded. Run teamai score --next for open work.`);
        default: {
          const unhandled: never = state;
          return unhandled;
        }
      }
    }
    return settle(leased);
  });
  if (outcome.status === 'busy') return error('busy', 'The judge attempts are locked by another process. Submit again.');
  const settled = outcome.value;
  if ('error' in settled) return settled;
  await fs.rm(evidenceDir(config, parsedRef.attempt), { recursive: true, force: true, maxRetries: 3 });
  return settled;
}

function usageOnHead(submission: JudgeSubmission, members: readonly [Judged, ...Judged[]], attempt: AttemptRecord) {
  const usage = attempt === members[0].attempt ? sumUsage(attempt.usage, submission.judge?.usage) : undefined;
  return usage ? { usage } : {};
}

async function publishLabels(config: LocalConfig, labelled: Labelled): Promise<SettledLease> {
  // Publishing is best effort: a label that does not reach teamai-reports now stays pending for the next pull.
  const delivery = await LabelStore.publish(config).catch((e: unknown) => ({ state: 'pending' as const, reason: e instanceof Error ? e.message : String(e) }));
  if (delivery.state === 'pending') log.debug(`[scores] Labels stay pending: ${delivery.reason}`);
  return { ...labelled, published: delivery.state === 'published' };
}

/** What the local judge that ran could do, the isolation it measured, and the model and effort it ran with. */
type LocalRun = Pick<Extract<ScoreLabel['judge'], { kind: 'model' }>, 'access' | 'isolation' | 'model' | 'effort'>;

/** The label's `model` and `effort`: what the judge ran with, by the local judge's account or the lease's, and the attempt's alias. */
function judgeIdentity(attempt: AttemptRecord, submission: JudgeSubmission, local: LocalRun | undefined): Pick<LocalRun, 'model' | 'effort'> {
  const ran = local ?? { model: { requested: attempt.judge.model?.name, reported: submission.judge?.model }, effort: { requested: attempt.judge.model?.effort } };
  const model = observedModel({ ...ran.model, alias: attempt.judge.alias });
  const effort = ran.effort && observedEffort(ran.effort);
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/** What a verdict's label holds on any subject: the scorer, its rubric, the label chosen, and the judge. */
type LabelVerdict = Omit<SessionLabel, 'source' | 'subject' | 'agent' | 'used'>;

/** A lease attempt's label, with the first prompt its reasoning file keeps and the session its share hint names. */
interface AttemptLabel {
  label: ScoreLabel;
  prompt?: string;
  sessionId?: string;
}

function toSucceeded(attempt: LeasedAttempt, settled: { settledAt: string; usage?: JudgeUsage; labelId: string; verdict: SucceededAttempt['verdict'] }): SucceededAttempt {
  return { ...attempt, settledAt: settled.settledAt, ...(settled.usage ? { usage: settled.usage } : {}), status: 'succeeded', labelId: settled.labelId, verdict: settled.verdict };
}

/**
 * A success must name a label of each scorer it judges, else nothing is written and the lease stays open; TeamAI
 * computes the score and whether it passed. `local` is the local judge that ran, at the isolation it measured. A driver's
 * own judge has the access its lease declared, and ran the model and effort the lease named, as the driver reports it.
 * With `publish: false` the labels stay pending, for the next pull to publish.
 */
async function labelJudgeLease(
  config: LocalConfig, ref: string, submission: Extract<JudgeSubmission, { outcome: 'success' }>, now: string, { local, publish = true }: { local?: LocalRun; publish?: boolean } = {},
): Promise<SettledLease> {
  const result = await settleJudgeLease(config, ref, submission.driver, now, async (lease): Promise<Labelled | Refusal> => {
    switch (lease.source) {
      case 'workflow':
        return labelMembers({ config, submission, now, local, members: lease.members, labelOf: (attempt, { scorer, rubric, label, score, passed, judge, scoredAt }) => {
          const judged = evidencePlan(lease.run, attempt.subject).passes;
          const reported = judged.flatMap((pass) => pass.used ?? []);
          const used = reported.length > 0 ? { skills: [...new Set(reported.flatMap((each) => each.skills))].sort() } : undefined;
          // The pass's mode, or the one every pass a workflow step ran agrees on: never the judge's.
          const runMode = agreedRunMode(judged.map((pass) => pass.runMode));
          return { label: { scorer, rubric, label, score, passed, source: 'workflow', subject: attempt.subject, ...(used ? { used } : {}), judge, ...(runMode ? { runMode } : {}), scoredAt } };
        } });
      case 'session':
        return labelMembers({ config, submission, now, local, members: lease.members, labelOf: (attempt, verdict) => ({
          label: sessionLabel(verdict, attempt.subject, attempt.session), prompt: attempt.session.prompt, sessionId: attempt.subject.sessionId,
        }) });
      default: {
        const unhandled: never = lease;
        return unhandled;
      }
    }
  });
  if ('error' in result) return result;
  return publish ? publishLabels(config, result) : { ...result, published: false };
}

async function labelMembers<T extends LeasedAttempt>({ config, submission, now, local, members, labelOf }: {
  config: LocalConfig;
  submission: Extract<JudgeSubmission, { outcome: 'success' }>;
  now: string;
  local: LocalRun | undefined;
  members: JudgedMembers<T>;
  labelOf: (attempt: T, verdict: LabelVerdict) => AttemptLabel;
}): Promise<Labelled | Refusal> {
  const [head] = members;
  const verdicts = verdictsOf(members, (member) => member.definition, submission.answer);
  if (!verdicts.ok) return error('label_invalid', verdicts.message);
  const tool = submission.judge?.tool ?? head.attempt.judge.tool;
  if (tool !== head.attempt.judge.tool) {
    return error('invalid_json', `judge.tool must match the tool selected by the lease: ${head.attempt.judge.tool}.`);
  }
  const isolation = local?.isolation ?? (submission.judge?.isolation === 'best-effort' ? 'best-effort' : head.attempt.judge.isolation);
  const scoring = await scopeScoring(config);
  if (!scoring.ok) return error('scoring_settings_invalid', scoring.reason);
  const required = requiredIsolation([
    ...scoring.isolation, ...members.map(({ attempt, pin, definition }) => ({ source: scorerIsolationSource(attempt.scorer, pin.relativePath), value: definition.isolation })),
  ]);
  if (!meets(isolation, required.level)) {
    return error('isolation_unmet', `This answer comes from a ${isolation} judge, and ${required.setBy.join(' and ')} asks for ${required.level}. The lease stays open: judge it at ${required.level} isolation, then submit again.`);
  }
  const settle = async ({ judged: { attempt, pin }, ...verdict }: (typeof verdicts.verdicts)[number]): Promise<SucceededAttempt> => {
    const { label, prompt, sessionId } = labelOf(attempt, {
      scorer: attempt.scorer,
      rubric: rubricOf(pin),
      label: verdict.label.value,
      score: verdict.label.score,
      passed: verdict.passed,
      judge: {
        kind: 'model',
        tool,
        ...judgeIdentity(attempt, submission, local),
        ...usageOnHead(submission, members, attempt),
        isolation,
        access: local?.access ?? attempt.judge.access,
        ...(members.length > 1 ? { batched: true as const } : {}),
      },
      scoredAt: now,
    });
    const { id, version } = await LabelStore.append(config, label, verdict.reasoning, prompt);
    if (!label.passed) log.info(shareFailedLabelHint(reasoningPath(config, version), sessionId));
    const succeeded = toSucceeded(attempt, {
      settledAt: now, ...usageOnHead(submission, members, attempt), labelId: id, verdict: { label: label.label, score: label.score, passed: label.passed, version },
    });
    await AttemptStore.write(config, succeeded);
    return succeeded;
  };
  const labelled: SucceededAttempt[] = [];
  for (const verdict of verdicts.verdicts) labelled.push(await settle(verdict));
  return { kind: 'labelled', attempts: labelled };
}

async function returnJudgeLease(config: LocalConfig, ref: string, submission: Extract<JudgeSubmission, { outcome: 'released' | 'failed' }>, now: string): Promise<SubmittedLease> {
  const result = await settleJudgeLease(config, ref, submission.driver, now, async (lease): Promise<Returned | Refusal> => {
    const members: JudgedMembers<LeasedAttempt> = lease.members;
    for (const { attempt } of members) {
      const settled = { settledAt: now, ...usageOnHead(submission, members, attempt) };
      const next: AttemptRecord = submission.outcome === 'released'
        ? { ...attempt, ...settled, status: 'released' }
        : { ...attempt, ...settled, status: 'failed', code: 'judge_failed' };
      await AttemptStore.write(config, next);
    }
    return { kind: 'returned', status: submission.outcome };
  });
  if ('error' in result) return result;
  switch (result.kind) {
    case 'labelled':
      return publishLabels(config, result);
    case 'returned':
      return result;
    default: {
      const unhandled: never = result;
      return unhandled;
    }
  }
}

function settledAnswer(config: LocalConfig, ref: string, settled: SubmittedLease): WorkflowEnvelope {
  if ('error' in settled) return settled;
  switch (settled.kind) {
    case 'labelled':
      return ok({ ...labelsAnswer(config, settled.attempts), published: settled.published });
    case 'returned':
      return ok({ settled: { ref, status: settled.status } });
    default: {
      const unhandled: never = settled;
      return unhandled;
    }
  }
}

export async function submitJudgeLease(config: LocalConfig, ref: string, submission: JudgeSubmission, now = new Date().toISOString()): Promise<WorkflowEnvelope> {
  switch (submission.outcome) {
    case 'success':
      return settledAnswer(config, ref, await labelJudgeLease(config, ref, submission, now));
    case 'released':
    case 'failed':
      return settledAnswer(config, ref, await returnJudgeLease(config, ref, submission, now));
    default: {
      const unhandled: never = submission;
      return unhandled;
    }
  }
}

/** Adds what a failed local judge call spent to the lease it ran for, which stays open. */
async function recordSpend(config: LocalConfig, head: AttemptRecord, usage: JudgeUsage | undefined): Promise<void> {
  if (!usage) return;
  const recorded = await AttemptStore.locked(config, async () => {
    const current = await AttemptStore.get(config, head.entry, head.attempt);
    if (current?.status === 'leased') await AttemptStore.write(config, { ...current, usage: sumUsage(current.usage, usage) });
  });
  if (recorded.status === 'busy') log.warn(`[scores] The judge attempts are locked by another process, so the spend of this judge call is not counted: ${JSON.stringify(usage)}.`);
}

/** How often, and how far apart, a session lease's write is tried while another process holds the attempts lock. */
const SESSION_WRITE_TRIES = 20;
const SESSION_WRITE_WAIT_MS = 250;

/** `write` tried again while it answers busy, so a session judge that ran is neither lost nor paid for twice. */
async function untilNotBusy<T>(write: () => Promise<T>, busy: (written: T) => boolean): Promise<T> {
  let written = await write();
  for (let tries = 1; tries < SESSION_WRITE_TRIES && busy(written); tries++) {
    await new Promise((resolve) => setTimeout(resolve, SESSION_WRITE_WAIT_MS));
    written = await write();
  }
  return written;
}

/**
 * Marks a session lease as judged here from `now` on, or refuses when it is settled or a local judge already started on
 * it: a session is judged once, whoever runs `score --lease <ref>` on it again.
 */
async function claimSessionJudge(config: LocalConfig, members: JudgedMembers<SessionAttempt>, ref: string, now: string): Promise<Refusal | undefined> {
  const claimed = await untilNotBusy(() => AttemptStore.locked(config, async (): Promise<Refusal | undefined> => {
    const current: LeasedSessionAttempt[] = [];
    for (const { attempt } of members) {
      const record = await AttemptStore.get(config, attempt.entry, attempt.attempt);
      if (record?.source !== 'session' || record.status !== 'leased') return error('lease_settled', `Judge lease ${ref} was already settled. Run score --next for more work.`);
      if (record.judgingSince !== undefined) {
        return error('lease_judging', `A local judge started on judge lease ${ref} at ${record.judgingSince}, and a session is judged once. Submit its answer, or run score --next for more work.`);
      }
      current.push(record);
    }
    for (const record of current) await AttemptStore.write(config, { ...record, judgingSince: now });
    return undefined;
  }), (outcome) => outcome.status === 'busy');
  return claimed.status === 'busy' ? error('busy', 'The judge attempts are locked by another process. Run the lease again.') : claimed.value;
}

/**
 * Closes a session lease whose local judge failed, with what the judge spent on its first scorer: a session is tried once,
 * so a background driver does not pay for it again.
 */
async function closeSessionLease(config: LocalConfig, members: JudgedMembers<SessionAttempt>, code: Exclude<JudgeFailureCode, 'evidence_empty'>, usage: JudgeUsage | undefined, now: string): Promise<void> {
  const closed = await untilNotBusy(() => AttemptStore.locked(config, async () => {
    for (const { attempt } of members) {
      const current = await AttemptStore.get(config, attempt.entry, attempt.attempt);
      if (current?.status !== 'leased' || current.source !== 'session') continue;
      const spent = attempt === members[0].attempt ? sumUsage(current.usage, usage) : current.usage;
      await AttemptStore.write(config, { ...current, ...(spent ? { usage: spent } : {}), status: 'failed', code, settledAt: now });
    }
  }), (outcome) => outcome.status === 'busy');
  if (closed.status === 'busy') log.warn('[scores] The judge attempts are locked by another process, so a failed session lease stays leased until it lapses.');
}

/**
 * Runs the lease's judge with its local tool profile, then settles the lease through the same path as `--submit`, at the
 * time `clock` gives once the judge returned. With `publish: false` its labels stay pending. With `group`, the judge
 * tool's process group is recorded in that directory.
 */
export async function judgeLease(
  config: LocalConfig, ref: string, driver: JudgeDriver,
  { clock = () => new Date().toISOString(), publish = true, group }: { clock?: () => string; publish?: boolean; group?: string } = {},
): Promise<SettledLease> {
  const key = parseLeaseRef(ref);
  const attempt = key && await AttemptStore.get(config, key.entry, key.attempt);
  if (!attempt) return error('lease_unknown', `Judge lease ${ref} is not on this machine. Run score --next in this scope.`);
  if (!sameDriver(attempt.driver, driver)) return error('wrong_driver', `Judge lease ${ref} belongs to a different driver.`);
  if (attempt.status !== 'leased') return error('lease_settled', `Judge lease ${ref} was already settled. Run score --next for more work.`);
  if (!isJudgeTool(attempt.judge.tool)) return error('judge_tool_unavailable', `The local judge cannot launch ${attempt.judge.tool}. Run that tool through its driver and submit the answer.`);
  const lease = await leaseMembers(config, attempt, ref);
  if (!('members' in lease)) return lease;
  const members: JudgedMembers<AttemptRecord> = lease.members;
  const rubrics = rubricsOf(members, (member) => member.definition);
  const evidence = evidenceDir(config, attempt.attempt);
  const built = lease.source === 'workflow'
    ? await buildEvidence(config, lease.run, lease.members[0].attempt.subject, rubrics, evidence)
    : await SessionWork.ensureEvidence(config, lease.members[0].attempt.subject, rubrics, evidence);
  if (!built.ok) {
    return error(built.code, lease.source === 'workflow'
      ? 'No recorded evidence could be read for this pass. Restore its commits or session, then retry.'
      : `Session ${lease.members[0].attempt.subject.sessionId} can no longer be read. The lease lapses and the session is not judged.`);
  }
  const scoring = await scopeScoring(config);
  if (!scoring.ok) return error('scoring_settings_invalid', scoring.reason);
  const isolation = requiredIsolation([...scoring.isolation, ...members.map(({ attempt: member, pin, definition }) => ({ source: scorerIsolationSource(member.scorer, pin.relativePath), value: definition.isolation }))]).level;
  if (lease.source === 'session') {
    const refused = await claimSessionJudge(config, lease.members, ref, clock());
    if (refused) return refused;
  }
  const result = await runLocalJudge({ tool: attempt.judge.tool, model: attempt.judge.model, evidence, schema: answerSchema(rubrics), isolation, ...(group !== undefined ? { group } : {}) });
  const verdicts = result.ok ? verdictsOf(members, (member) => member.definition, result.answer) : undefined;
  if (!result.ok || !verdicts?.ok) {
    const spent = result.ok ? result.judge.usage : result.usage;
    if (lease.source === 'session') {
      await closeSessionLease(config, lease.members, result.ok ? 'judge_answer_invalid' : result.code, spent, clock());
      await fs.rm(evidence, { recursive: true, force: true, maxRetries: 3 });
    } else {
      await recordSpend(config, lease.members[0].attempt, spent);
    }
    const raw = result.ok ? JSON.stringify(result.answer) : result.raw;
    let saved = '';
    if (raw !== undefined) {
      const file = rawOutputPath(config, attempt.attempt);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, raw, { mode: 0o600 });
      saved = ` Output saved to ${file}.`;
    }
    const closed = lease.source === 'session' ? ' The session lease closed, and the session is not judged again.' : '';
    return result.ok
      ? error('judge_answer_invalid', `The judge's answer does not fit the lease: ${verdicts && !verdicts.ok ? verdicts.message : ''}${closed || ' Retry or submit a valid answer.'}${saved}`)
      : error(result.code, closed ? `The session lease closed, and the session is not judged again. The judge reported: ${result.message}${saved}` : result.message + saved);
  }
  const { access, model, effort, ...judge } = result.judge;
  const settledAt = clock();
  const label = () => labelJudgeLease(config, ref, { driver, outcome: 'success', answer: result.answer, judge }, settledAt, { local: { access, isolation: judge.isolation, model, effort }, publish });
  // A session judge's answer is kept through a busy lock: it is not judged again to recover it.
  const labelled = lease.source === 'session' ? await untilNotBusy(label, (settled) => 'error' in settled && settled.error.code === 'busy') : await label();
  // A session is judged once: a judge that ran below the isolation its scorers ask for closes the lease too.
  if (lease.source === 'session' && 'error' in labelled && labelled.error.code === 'isolation_unmet') {
    await closeSessionLease(config, lease.members, 'judge_failed', judge.usage, clock());
    await fs.rm(evidence, { recursive: true, force: true, maxRetries: 3 });
  }
  return labelled;
}

/** `teamai score --lease <ref>` with `value` as its payload: `judgeLease` for the driver it names. */
export async function runJudgeLease(config: LocalConfig, ref: string, value: unknown, options: { clock?: () => string; group?: string } = {}): Promise<WorkflowEnvelope> {
  const parsed = z.object({ driver: DriverSchema }).safeParse(value);
  if (!parsed.success) return error('invalid_json', issueText(parsed.error.issues));
  return settledAnswer(config, ref, await judgeLease(config, ref, parsed.data.driver, options));
}

/** What `teamai score --run <id> --step <path> [--pass <n>] --scorer <name>… [--queue] [--batch]` asks for. */
export interface ScoreDemand {
  run: string;
  step: string;
  /** Omitted: the step's latest succeeded pass. */
  pass?: number;
  scorers: readonly string[];
  /** Leave the judging to any driver's `teamai score --next`. */
  queue?: boolean;
  /** The scorers share one judge call when they resolve to the same tool and model. */
  batch?: boolean;
}

/**
 * Judges a pass with the named scorers whatever sampling says, and reopens an entry that failed or expired. A scorer the
 * run pinned judges with that rubric; any other scorer cached here, with its current one. Records a request per scorer,
 * then judges here with the local judge, or with `queue` leaves the work to any driver.
 */
export async function scoreOnDemand(config: LocalConfig, demand: ScoreDemand, now = new Date().toISOString()): Promise<WorkflowEnvelope> {
  const unavailable = scoringUnavailable(config);
  if (unavailable) return error('scoring_unavailable', unavailable);
  const scoring = await scopeScoring(config);
  if (!scoring.ok) return error('scoring_settings_invalid', scoring.reason);
  const run = isRunId(demand.run) ? await readRun(config, demand.run) : 'missing';
  if (typeof run !== 'object') {
    const ids = (await localRuns(config)).reverse().slice(0, 10).map((known) => known.id);
    return error('run_not_found', `Run ${demand.run} is not on this machine. ${ids.length > 0 ? `Runs here, newest first: ${ids.join(', ')}.` : 'This scope has no runs.'}`);
  }
  const judgeable = judgeablePasses(run).map(({ pass }) => pass);
  const ofStep = judgeable.filter((pass) => pass.step === demand.step).map((pass) => pass.pass).sort((left, right) => left - right);
  const latest = ofStep.at(-1);
  if (latest === undefined) {
    const steps = [...new Set(judgeable.map((pass) => pass.step))];
    return error('step_not_found', `Step ${demand.step} has no succeeded pass in run ${run.id}. ${steps.length > 0 ? `Steps with one: ${steps.join(', ')}.` : 'No step of it succeeded.'}`);
  }
  const pass = demand.pass ?? latest;
  if (!ofStep.includes(pass)) return error('pass_not_found', `Pass ${pass} of step ${demand.step} did not succeed in run ${run.id}. Succeeded passes: ${ofStep.join(', ')}.`);
  const subject: RunSubject = { runId: run.id, step: demand.step, pass };
  const cached = await pinScorers(config, demand.scorers.filter((name) => !Object.hasOwn(run.scorers ?? {}, name)));
  const asked: Array<{ scorer: string; pin: PinnedScorer }> = [];
  for (const scorer of new Set(demand.scorers)) {
    const pin = run.scorers?.[scorer] ?? cached[scorer];
    if (!pin || !pinnedDefinition(scorer, pin)) {
      const known = [...new Set([...Object.keys(run.scorers ?? {}), ...await cachedScorerNames(config)])].sort();
      return error('scorer_not_found', `Scorer ${scorer} is neither pinned by run ${run.id} nor cached here. ${known.length > 0 ? `Scorers: ${known.join(', ')}.` : 'Run teamai pull to cache the team\'s scorers.'}`);
    }
    asked.push({ scorer, pin });
  }
  const recorded = await AttemptStore.locked(config, async () => {
    for (const { scorer, pin } of asked) {
      await AttemptStore.writeRequest(config, { entry: entryIdOf(scorer, subject), scorer, subject, pin, requestedAt: now, ...(demand.batch ? { batch: true } : {}) });
    }
  });
  if (recorded.status === 'busy') return error('busy', 'The judge attempts are locked by another process. Ask again.');
  if (demand.queue) return ok({ queued: asked.map(({ scorer }) => ({ scorer, subject })) });

  const [tool, ...tools] = installedJudgeTools(evidencePlan(run, subject).passes.flatMap((judged) => judged.tool ?? []));
  if (!tool) return error('judge_tool_unavailable', `No judge tool is on PATH. Install one of: ${JUDGE_TOOLS.join(', ')}, or add --queue so another driver judges this pass.`);
  const driver = driverIdentity('local', process.cwd());
  const ids = asked.map(({ scorer }) => entryIdOf(scorer, subject));
  const labelled: SucceededAttempt[] = [];
  let published = true;
  for (;;) {
    const taken = await takeJudgeLease(config, { driver, judge: { isolation: 'verified', tools: [tool, ...tools] }, running: [], entries: { source: 'workflow', ids } }, now);
    if (taken.kind === 'busy') return error('busy', 'The judge attempts are locked by another process. Ask again.');
    if (taken.closed.some((closed) => closed.code === 'evidence_empty')) {
      return error('evidence_empty', 'No recorded evidence could be read for this pass. Restore its commits or session, then run this command again.');
    }
    if (taken.kind === 'idle') {
      if (taken.skipped.length === 0) break;
      const message = taken.skipped.map((skipped) => skipped.message).join(' ');
      if (labelled.length === 0) return error('judge_model_unavailable', message);
      const kept = labelled.map((attempt) => `${attempt.scorer}: ${attempt.verdict.label}`).join(', ');
      return { error: { code: 'judge_model_unavailable', message: `${message} Kept the label of ${kept}.`, labels: labelled.map((attempt) => labelAnswer(config, attempt)) } };
    }
    const judged = await judgeLease(config, taken.lease.ref, driver);
    if ('error' in judged) return judged;
    labelled.push(...judged.attempts);
    published &&= judged.published;
  }
  if (labelled.length === 0) return error('entry_leased', 'Another driver holds the judge lease for this pass. Retry once it settles or lapses (30 minutes), or add --queue.');
  return ok({ ...labelsAnswer(config, labelled), published });
}
