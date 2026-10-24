/**
 * Judge work for workflow passes (#1085). Nothing is queued: open work is computed from the run files, the scorers each
 * run pinned, the label store and the attempt store on every `teamai score --next`. The engine never calls this module,
 * and this module never writes a run file, so scoring cannot move a run's counts, tokens, failure or end time.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DriverSchema } from '../driver-identity.js';
import type { LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';
import {
  AttemptStore, newAttemptId, rawOutputPath, scoresDir, type AttemptRecord, type JudgeDriver, type LeasedAttempt, type ScoreRequest, type SucceededAttempt,
} from '../scorers/attempts.js';
import { batchesScorers, JudgeAnswerSchema, verdictsOf } from '../scorers/batch.js';
import { cachedScorerNames, pinScorers } from '../scorers/cache.js';
import { pinnedDefinition, type PinnedScorer } from '../scorers/pin.js';
import type { ScorerDefinition } from '../scorers/definition.js';
import {
  ENTRY_WINDOW_MS, LEASE_TTL_MS, entryIdOf, entryState, hasLapsed, leaseRefOf, parseLeaseRef, type EntryState,
} from '../scorers/entry.js';
import { observedEffort, observedModel } from '../agent-observation.js';
import { ACCESS_LEVELS, ISOLATIONS, JudgeUsageSchema, sumUsage, type Isolation, type JudgeAccess, type JudgeUsage, type RunSubject, type ScoreLabel } from '../scorers/label.js';
import { LabelStore, reasoningPath, shareFailedLabelHint } from '../scorers/label-store.js';
import { installedJudgeTools, isJudgeTool, runLocalJudge } from '../scorers/judge.js';
import { loadModelAliases } from '../models/aliases.js';
import { chooseJudgeModel } from '../scorers/judge-model.js';
import { isSampled } from '../scorers/sampling.js';
import { scoringUnavailable } from '../scorers/home.js';
import { requiredIsolation, scorerIsolationSource, unknownIsolationText, type IsolationSetting } from '../scorers/isolation.js';
import { scopeScoring } from '../scorers/settings.js';
import { answerSchema, evidenceDirOf, sweepEvidence, type Rubrics } from '../scorers/evidence.js';
import { buildEvidence, evidencePlan } from './scoring-evidence.js';
import { error, ok } from './engine.js';
import { localDriver } from './local-driver.js';
import { firstSettled, passesWithin, runPasses, type RunPass } from './loop.js';
import { stepDefinitions } from './scope.js';
import { parseStepPath } from './step-path.js';
import { installOwner, isRunId, readRun, runsDir } from './store.js';
import type { InlineWorkflow, RunState, WorkflowDefinition, WorkflowEnvelope, WorkflowStep } from './types.js';

/** A succeeded pass of a step that lists scorers this run pinned. */
interface ScorablePass {
  subject: RunSubject;
  scorers: string[];
}

/** Whether this install settled `pass`: its stamp, or, for a pass settled before stamps, a run no other install handed over. */
function settledHere(run: RunState, pass: RunPass, install: string): boolean {
  return pass.installId === undefined ? run.publication === undefined : pass.installId === install;
}

/** The passes a judge can judge: succeeded passes of prompt and workflow steps, and of a `for_each` step only its items. */
function judgeablePasses(run: RunState): Array<{ pass: RunPass; definition: WorkflowStep }> {
  const definitionOf = stepDefinitions(run);
  return runPasses(run).flatMap((pass) => {
    const definition: WorkflowStep | undefined = definitionOf(pass.step);
    if (pass.outcome !== 'success' || !definition) return [];
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
  const all = runPasses(run);
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
  /** On demand: only these entries. */
  entries?: readonly string[];
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
  return { driver, judge: can.judge, running: parsed.data.running };
}

export function parseJudgeSubmission(value: unknown): JudgeSubmission | string {
  const parsed = SubmitPayloadSchema.safeParse(value);
  if (!parsed.success) return issueText(parsed.error.issues);
  const { outcome, answer, ...submission } = parsed.data;
  if (outcome !== 'success') return { ...submission, outcome };
  return answer ? { ...submission, outcome, answer } : 'answer: a success needs answer.label and answer.reasoning, or one of those per scorer of a batch';
}

function sameDriver(left: JudgeDriver, right: JudgeDriver): boolean {
  return left.kind === right.kind && left.machine === right.machine && left.workspace === right.workspace;
}

/** One sampled (scorer, pass) with its derived state. */
interface ScoreEntry {
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

/** Every readable run of this scope, oldest first. */
async function localRuns(config: LocalConfig): Promise<RunState[]> {
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
async function scoreEntries(config: LocalConfig, now: string, teamBatch: boolean | undefined): Promise<ScoreEntry[]> {
  const install = (await installOwner(config)).id;
  const [labels, attempts, requests] = await Promise.all([LabelStore.local(config), AttemptStore.read(config), AttemptStore.requests(config)]);
  const kept = new Set([
    ...[...attempts.values()].flat().filter((attempt) => attempt.status === 'leased' && !hasLapsed(attempt, now)).map((attempt) => attempt.subject.runId),
    ...requests.map((request) => request.subject.runId),
  ]);
  const runs = await recentRuns(config, now, kept);
  return runs.flatMap((run) => {
    const entryOf = (scorer: string, pin: PinnedScorer, subject: RunSubject, request?: ScoreRequest): ScoreEntry[] => {
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
      return [{ id, run, scorer, pin, definition, subject, state, batch, ...(request ? { requestedAt: request.requestedAt } : {}) }];
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
  entry: ScoreEntry;
  attempt: LeasedAttempt;
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

async function leaseAnswer(config: LocalConfig, members: Members, handedBack: boolean) {
  const [{ entry, attempt }] = members;
  const dir = evidenceDir(config, attempt.attempt);
  const prompt = path.join(dir, 'prompt.md');
  const ref = leaseRefOf(attempt);
  const batched = members.length > 1;
  return {
    ref,
    ...(batched
      ? { scorers: members.map((member) => member.entry.scorer), rubrics: Object.fromEntries(members.map((member) => [member.entry.scorer, rubricOf(member.entry.pin)])) }
      : { scorer: entry.scorer, rubric: rubricOf(entry.pin) }),
    subject: attempt.subject,
    judge: attempt.judge,
    evidence: dir,
    prompt,
    answer: { schema: answerSchema(rubricsOf(members, (member) => member.entry.definition)) },
    expiresAt: attempt.expiresAt,
    ...(entry.run.checkout ? { cwd: entry.run.checkout } : {}),
    submit: `teamai score --lease ${ref} --submit --stdin`,
    ...(batched ? { batched: true } : {}),
    ...(handedBack ? { handedBack: true } : {}),
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
interface SkippedEntry {
  scorer: string;
  subject: RunSubject;
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
 * longer offers the tool or isolation for, or whose kept rubric is gone, renews the leases it lists in `running`, hands
 * back one it left out with the rubric it was taken with, else
 * leases the first open entry, oldest run first, whose isolation the driver meets. When its step batches scorers, the
 * other open entries of the same pass that resolve to the same tool and model join that lease. Answers `idle` with
 * counts when there is none. An entry whose evidence is empty closes, and the next one is tried. An entry whose scorer's
 * model none of the driver's tools runs is skipped and stays open for another driver.
 */
export async function takeJudgeLease(config: LocalConfig, request: JudgeRequest, now: string): Promise<TakenLease> {
  const earlier: ClosedEntry[] = [];
  for (;;) {
    const taken = await takeOneLease(config, request, now);
    switch (taken.kind) {
      case 'evidence_empty':
        earlier.push(...taken.closed);
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

async function takeOneLease(config: LocalConfig, request: JudgeRequest, now: string): Promise<OneLease | { kind: 'busy' } | { kind: 'evidence_empty'; closed: ClosedEntry[] }> {
  const unavailable = scoringUnavailable(config);
  if (unavailable) {
    log.warn(unavailable);
    return { kind: 'idle', open: 0, leased: 0, skipped: [] };
  }
  const scoring = await scopeScoring(config);
  if (!scoring.ok) {
    log.warn(scoring.reason);
    return { kind: 'idle', open: 0, leased: 0, skipped: [] };
  }
  const all = await scoreEntries(config, now, scoring.batch);
  const found = all.filter((entry) => !request.entries || request.entries.includes(entry.id));
  const aliases = await loadModelAliases(config);
  const { isolation } = scoring;
  for (const unknown of requiredIsolation(isolation).unknown) log.warn(`${unknownIsolationText(unknown)}.`);
  for (const problem of scoring.problems) log.warn(`${problem}.`);
  const skipped: SkippedEntry[] = [];
  const released = new Set<string>();
  const isOpen = (entry: ScoreEntry) => entry.state.kind === 'open' || released.has(entry.id);
  const leasable = (entry: ScoreEntry) => isOpen(entry) && meets(request.judge.isolation, requiredFor(isolation, entry));
  const running = new Set(request.running.flatMap((ref) => parseLeaseRef(ref)?.attempt ?? []));
  const outcome = await AttemptStore.locked(config, async (): Promise<{ members: Members; handedBack: boolean } | undefined> => {
    for (const entry of all) {
      if (entry.requestedAt !== undefined && entry.state.kind !== 'open' && entry.state.kind !== 'leased') await AttemptStore.closeRequest(config, entry.id, entry.requestedAt);
    }
    await AttemptStore.sweep(config);
    // Re-read under the lock: another driver may have taken an entry since the unlocked read.
    const isFresh = async (entry: ScoreEntry) =>
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
      } else {
        const member = { entry: { ...entry, ...rubric }, attempt: live };
        const lease = mine.get(live.attempt);
        mine.set(live.attempt, lease ? [...lease, member] : [member]);
      }
    }
    const [back] = mine.values();
    if (back) return { members: back, handedBack: true };
    for (const entry of found) {
      if (!leasable(entry) || !await isFresh(entry)) continue;
      const chosen = chooseJudgeModel(aliases, entry.definition, request.judge.tools);
      const attempt = newAttemptId();
      const leased = (member: ScoreEntry, choice: JudgeChoice, batch?: string[]): LeasedAttempt => ({
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
      const mates: Array<{ entry: ScoreEntry; choice: JudgeChoice }> = [];
      for (const other of entry.batch ? found : []) {
        if (other === entry || other.subject.runId !== entry.subject.runId || other.subject.step !== entry.subject.step || other.subject.pass !== entry.subject.pass) continue;
        const choice = chooseJudgeModel(aliases, other.definition, request.judge.tools);
        if (choice.ok && sameChoice(choice.choice, chosen.choice) && leasable(other) && await isFresh(other)) mates.push({ entry: other, choice: choice.choice });
      }
      const batch = mates.length > 0 ? [entry.id, ...mates.map((mate) => mate.entry.id)] : undefined;
      const members: Members = [{ entry, attempt: leased(entry, chosen.choice, batch) }, ...mates.map((mate) => ({ entry: mate.entry, attempt: leased(mate.entry, mate.choice, batch) }))];
      for (const member of members) await AttemptStore.keepRubric(config, member.entry.pin);
      for (const member of members) await AttemptStore.write(config, member.attempt);
      return { members, handedBack: false };
    }
    return undefined;
  });
  if (outcome.status === 'busy') return { kind: 'busy' };
  const leased = outcome.value;
  const attempts = await AttemptStore.read(config);
  await sweepEvidence(scoresDir(config), new Set([...attempts.values()].flat()
    .filter((attempt) => attempt.status !== 'leased' || hasLapsed(attempt, now)).map((attempt) => attempt.attempt)));
  if (leased) {
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
    return { kind: 'lease', lease: await leaseAnswer(config, leased.members, leased.handedBack), skipped };
  }
  return {
    kind: 'idle',
    open: found.filter(isOpen).length,
    leased: found.filter((entry) => entry.state.kind === 'leased' && !released.has(entry.id)).length,
    skipped,
  };
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

/**
 * The attempts of the lease `attempt` belongs to, one per scorer it judges in the step's order, with their pinned
 * scorers; or the error that says which is missing.
 */
async function leaseMembers(config: LocalConfig, attempt: AttemptRecord, ref: string): Promise<{ run: RunState; members: readonly [Judged, ...Judged[]] } | Refusal> {
  const run = await readRun(config, attempt.subject.runId);
  const records = await Promise.all((attempt.batch ?? [attempt.entry]).map((entry) => AttemptStore.get(config, entry, attempt.attempt)));
  const members: Judged[] = [];
  for (const record of records) {
    if (!record) return error('lease_unknown', `Judge lease ${ref} is not on this machine.`);
    const rubric = await leasedRubric(config, record);
    if (typeof run !== 'object') return error('lease_unknown', `Run ${record.subject.runId}, which judge lease ${ref} was for, is not on this machine.`);
    if (!rubric) return error('lease_unknown', `The rubric of scorer ${record.scorer} that judge lease ${ref} was taken with is not on this machine.`);
    members.push({ attempt: record, ...rubric });
  }
  const [head, ...tail] = members;
  if (!head || typeof run !== 'object') return error('lease_unknown', `Judge lease ${ref} is not on this machine.`);
  return { run, members: [head, ...tail] };
}

function isSucceeded(member: Judged): member is Judged<SucceededAttempt> {
  return member.attempt.status === 'succeeded';
}

/** Settles an open lease through `settle`; a lease already labelled answers its own labels again. */
async function settleJudgeLease<T extends { kind: string }>(
  config: LocalConfig, ref: string, driver: JudgeDriver, now: string, settle: (members: readonly [Judged, ...Judged[]], run: RunState) => Promise<T | Refusal>,
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
    const { run, members } = lease;
    const [head] = members;
    if (!sameDriver(head.attempt.driver, driver)) return error('wrong_driver', `Judge lease ${ref} belongs to a different driver.`);
    const succeeded = members.filter(isSucceeded);
    if (succeeded.length === members.length) return { kind: 'labelled', attempts: succeeded.map((member) => member.attempt) };
    const settledAs = members.find((member) => member.attempt.status !== 'leased')?.attempt.status;
    if (settledAs) return error('lease_settled', `Judge lease ${ref} was already settled as ${settledAs}.`);
    for (const { attempt } of members) {
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
    return settle(members, run);
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

/**
 * A success must name a label of each scorer it judges, else nothing is written and the lease stays open; TeamAI
 * computes the score and whether it passed. `local` is the local judge that ran, at the isolation it measured. A driver's
 * own judge has the access its lease declared, and ran the model and effort the lease named, as the driver reports it.
 */
async function labelJudgeLease(config: LocalConfig, ref: string, submission: Extract<JudgeSubmission, { outcome: 'success' }>, now: string, local?: LocalRun): Promise<SettledLease> {
  const result = await settleJudgeLease(config, ref, submission.driver, now, async (members, run): Promise<Labelled | Refusal> => {
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
      const reported = evidencePlan(run, attempt.subject).passes.flatMap((judged) => judged.used ?? []);
      const used = reported.length > 0 ? { skills: [...new Set(reported.flatMap((each) => each.skills))].sort() } : undefined;
      const label: ScoreLabel = {
        scorer: attempt.scorer,
        rubric: rubricOf(pin),
        label: verdict.label.value,
        score: verdict.label.score,
        passed: verdict.passed,
        source: 'workflow',
        subject: attempt.subject,
        ...(used ? { used } : {}),
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
      };
      const { id, version } = await LabelStore.append(config, label, verdict.reasoning);
      if (!label.passed) log.info(shareFailedLabelHint(reasoningPath(config, version)));
      const succeeded: SucceededAttempt = {
        ...attempt, settledAt: now, ...usageOnHead(submission, members, attempt), status: 'succeeded', labelId: id, verdict: { label: label.label, score: label.score, passed: label.passed, version },
      };
      await AttemptStore.write(config, succeeded);
      return succeeded;
    };
    const labelled: SucceededAttempt[] = [];
    for (const verdict of verdicts.verdicts) labelled.push(await settle(verdict));
    return { kind: 'labelled', attempts: labelled };
  });
  return 'error' in result ? result : publishLabels(config, result);
}

async function returnJudgeLease(config: LocalConfig, ref: string, submission: Extract<JudgeSubmission, { outcome: 'released' | 'failed' }>, now: string): Promise<SubmittedLease> {
  const result = await settleJudgeLease(config, ref, submission.driver, now, async (members): Promise<Returned | Refusal> => {
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

/** Runs the lease's judge with its local tool profile, then settles the lease through the same path as `--submit`. */
export async function judgeLease(config: LocalConfig, ref: string, driver: JudgeDriver): Promise<SettledLease> {
  const key = parseLeaseRef(ref);
  const attempt = key && await AttemptStore.get(config, key.entry, key.attempt);
  if (!attempt) return error('lease_unknown', `Judge lease ${ref} is not on this machine. Run score --next in this scope.`);
  if (!sameDriver(attempt.driver, driver)) return error('wrong_driver', `Judge lease ${ref} belongs to a different driver.`);
  if (attempt.status !== 'leased') return error('lease_settled', `Judge lease ${ref} was already settled. Run score --next for more work.`);
  if (!isJudgeTool(attempt.judge.tool)) return error('judge_tool_unavailable', `The local judge cannot launch ${attempt.judge.tool}. Run that tool through its driver and submit the answer.`);
  const lease = await leaseMembers(config, attempt, ref);
  if (!('members' in lease)) return lease;
  const rubrics = rubricsOf(lease.members, (member) => member.definition);
  const evidence = evidenceDir(config, attempt.attempt);
  const built = await buildEvidence(config, lease.run, attempt.subject, rubrics, evidence);
  if (!built.ok) return error(built.code, 'No recorded evidence could be read for this pass. Restore its commits or session, then retry.');
  const scoring = await scopeScoring(config);
  if (!scoring.ok) return error('scoring_settings_invalid', scoring.reason);
  const isolation = requiredIsolation([...scoring.isolation, ...lease.members.map(({ attempt: member, pin, definition }) => ({ source: scorerIsolationSource(member.scorer, pin.relativePath), value: definition.isolation }))]).level;
  const result = await runLocalJudge({ tool: attempt.judge.tool, model: attempt.judge.model, evidence, schema: answerSchema(rubrics), isolation });
  const verdicts = result.ok ? verdictsOf(lease.members, (member) => member.definition, result.answer) : undefined;
  if (!result.ok || !verdicts?.ok) {
    await recordSpend(config, lease.members[0].attempt, result.ok ? result.judge.usage : result.usage);
    const raw = result.ok ? JSON.stringify(result.answer) : result.raw;
    let saved = '';
    if (raw !== undefined) {
      const file = rawOutputPath(config, attempt.attempt);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, raw, { mode: 0o600 });
      saved = ` Output saved to ${file}.`;
    }
    return result.ok
      ? error('judge_answer_invalid', `The judge's answer does not fit the lease: ${verdicts && !verdicts.ok ? verdicts.message : ''} Retry or submit a valid answer.${saved}`)
      : error(result.code, result.message + saved);
  }
  const { access, model, effort, ...judge } = result.judge;
  return labelJudgeLease(config, ref, { driver, outcome: 'success', answer: result.answer, judge }, new Date().toISOString(), { access, isolation: judge.isolation, model, effort });
}

export async function runJudgeLease(config: LocalConfig, ref: string, value: unknown): Promise<WorkflowEnvelope> {
  const parsed = z.object({ driver: DriverSchema }).safeParse(value);
  if (!parsed.success) return error('invalid_json', issueText(parsed.error.issues));
  return settledAnswer(config, ref, await judgeLease(config, ref, parsed.data.driver));
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
  if (!tool) return error('judge_tool_unavailable', 'No judge tool is on PATH. Install Claude Code, Codex, OpenCode or CodeBuddy, or add --queue so another driver judges this pass.');
  const driver = localDriver(process.cwd());
  const ids = asked.map(({ scorer }) => entryIdOf(scorer, subject));
  const labelled: SucceededAttempt[] = [];
  let published = true;
  for (;;) {
    const taken = await takeJudgeLease(config, { driver, judge: { isolation: 'verified', tools: [tool, ...tools] }, running: [], entries: ids }, now);
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
