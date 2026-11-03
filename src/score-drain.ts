/**
 * `teamai score --drain` (#1385): what every driver runs before an unattended job ends, and the local driver at the end
 * of an unattended run. It drives a teamai-finished-sessions run here, which archives and judges the finished sessions
 * and starts the lapsed judging again, publishes labels and run records, reports usage, and says what is left.
 */
import { z } from 'zod';
import { loadTeamConfig } from './config.js';
import { resolveWorkflowEnv } from './env-resolution.js';
import type { RunMode } from './launch-context.js';
import { scoringUnavailable } from './scorers/home.js';
import { scopeScoring } from './scorers/settings.js';
import { Subject } from './scorers/subject.js';
import { SessionCaptures } from './session-flow/captures.js';
import { FINISHED_WORKFLOW, FinishedSessions } from './session-flow/finished-sessions.js';
import { SessionPolicy } from './session-flow/session-policy.js';
import { SessionPublish, type StepSessionsPublished } from './session-flow/session-publish.js';
import type { RunSubject, SessionSubject } from './scorers/label.js';
import { LabelStore } from './scorers/label-store.js';
import { reportUsage } from './team-push.js';
import { isUsageReportEnabled, usesBranchWorktree, type LocalConfig } from './types.js';
import { log } from './utils/logger.js';
import { agentSessionIdFromEnv } from './utils/session-id.js';
// oxlint-disable-next-line teamai/workflow-boundaries -- the drain drives the teamai-finished-sessions run it starts, as workflow start --driver local does
import { runLocalDriver } from './workflow/drivers/local/local-driver.js';
import { inProcessClient } from './workflow/protocol.js';
import { pendingRecords, publishPendingRecords } from './workflow/records.js';
import type { StepState } from './workflow/step-state.js';
import { readRun } from './workflow/store.js';
import type { RunState, WorkflowEnvelope } from './workflow/types.js';

/** A pass or a session the drain's run judged, by the scorers that got a label. */
interface Judged {
  source: 'workflow' | 'session';
  scorers: readonly string[];
}

/** A judgment that failed here. It is final: no drain judges it again. */
interface FailedJudgment {
  scorers: readonly string[];
  subject: RunSubject | SessionSubject;
  code: string;
}

/** What could not reach teamai-reports, of one kind, and why. It stays pending, and the next drain retries it. */
interface Unpublished {
  kind: 'runRecords' | 'labels' | 'sessions';
  count: number;
  reason: string;
}

/** The judging the drain's run left for a driver that can take it: of how many passes and sessions, and why. */
interface Held {
  run: string;
  passes: number;
  sessions: number;
  reason: string;
}

/** What one drain did across its scopes. */
export interface DrainResult {
  judged: Judged[];
  failed: FailedJudgment[];
  /** The judge steps of the drain's runs that no driver here can take, left open for another driver's `workflow next`. */
  held: Held[];
  /** How many passes and sessions wait for their CI, which the next drain labels once it finished. */
  ciPending: { passes: number; sessions: number };
  /** The teamai-finished-sessions runs already working on a scope, which the drain left to their driver. */
  working: string[];
  /** Why a teamai-finished-sessions run did not start, or ended failed, for each scope where it did. */
  broke: string[];
  /** Runs whose queued workflow run records reached teamai-reports. */
  runRecordsPublished: number;
  labelsPublished: number;
  /** Captured sessions archived on teamai-reports. */
  capturedArchived: number;
  /** The step sessions of each run ended here, archived on teamai-reports or skipped. */
  steps: StepSessionsPublished[];
  unpublished: Unpublished[];
  /** The usage of each scope that had new usage to report, by the member whose `stats/<member>.yaml` it goes to. */
  usage: Array<{ member: string; reported: boolean }>;
}

type Finished = Pick<DrainResult, 'judged' | 'failed' | 'held' | 'ciPending' | 'working' | 'broke' | 'capturedArchived' | 'unpublished'>;

const nothing = (): Finished => ({ judged: [], failed: [], held: [], ciPending: { passes: 0, sessions: 0 }, working: [], broke: [], capturedArchived: 0, unpublished: [] });

/** In unattended mode, every session captured unattended in this data home is finished from now on. */
async function finishUnattended(config: LocalConfig, now: string): Promise<void> {
  for (const captured of await SessionCaptures.list(config)) {
    if (SessionCaptures.runModeOf(captured.captures) === 'unattended' && !captured.drained) await SessionCaptures.markDrained(config, captured, now);
  }
}

const GroupsSchema = z.object({ groups: z.array(z.object({ subject: z.string() })) });

const LabelEntriesSchema = z.object({ labels: z.array(z.object({ scorer: z.string(), code: z.string() })) });

const OPEN = new Set<StepState['status']>(['pending', 'waiting', 'leased', 'running']);

/** What a drain reads of its run: what it judged, archived and left, and how many judge steps are still open. */
interface Reading {
  into: Finished;
  open: { passes: number; sessions: number };
}

/** What the teamai-score plan group `index` under `prefix` gave its subject, added to the reading. */
function readGroup(ran: RunState, { prefix, index, text }: { prefix: string; index: number; text: string }, { into, open }: Reading): void {
  const parsed = Subject.parse(text);

  if (!parsed.ok || parsed.subject.kind === 'team-session') return;
  const { subject } = parsed.subject;
  const kind = parsed.subject.kind === 'run' ? 'passes' : 'sessions';
  const step = (name: string) => ran.steps.find((one) => one.id === `${prefix}.score[${index}].${name}`);
  const judge = step('judge');

  if (judge && OPEN.has(judge.status)) {
    open[kind] += 1;

    return;
  }

  const label = step('label');
  const entries = LabelEntriesSchema.safeParse(label?.status === 'succeeded' ? label.outputs : undefined).data?.labels ?? [];
  const labelled = entries.filter((entry) => entry.code === '').map((entry) => entry.scorer);

  if (labelled.length > 0) into.judged.push({ source: parsed.subject.kind === 'run' ? 'workflow' : 'session', scorers: labelled });

  if (entries.some((entry) => entry.code === 'ci_pending')) into.ciPending[kind] += 1;

  for (const code of new Set(entries.map((entry) => entry.code).filter((one) => one !== '' && one !== 'ci_pending'))) {
    into.failed.push({ scorers: entries.filter((entry) => entry.code === code).map((entry) => entry.scorer), subject, code });
  }
}

/**
 * What `ran` judged, through the plan and label steps of each teamai-score it ran, and archived, through the publish
 * step of each teamai-share-session, as the shipped files name them.
 */
function readFinished(ran: RunState, reading: Reading): void {
  const ids = new Set(ran.steps.map((step) => step.id));

  for (const step of ran.steps) {
    const [, prefix = '', name] = /^(.+)\.(plan|publish)$/u.exec(step.id) ?? [];

    if (name === 'plan') {
      const groups = GroupsSchema.safeParse(step.status === 'succeeded' ? step.outputs : undefined).data?.groups ?? [];
      groups.forEach((group, index) => readGroup(ran, { prefix, index, text: group.subject }, reading));
    } else if (name === 'publish' && !ids.has(`${prefix}.plan`)) {
      if (step.status === 'succeeded') reading.into.capturedArchived += 1;

      if (step.status === 'failed') reading.into.unpublished.push({ kind: 'sessions', count: 1, reason: step.failure?.message ?? 'teamai session push failed' });
    }
  }
}

/** Why `run` ended failed: each of its own steps that failed, with what it said. */
function failedSteps(ran: RunState): string {
  const said = ran.steps.flatMap((step) => (step.status === 'failed' && !/[.[]/u.test(step.id)
    ? [`step ${step.id} failed${step.failure ? `: ${step.failure.message.replace(/\.$/u, '')}` : ''}`]
    : []));

  return said.join('; ') || 'no step says why';
}

/** What the local driver answered for `run`, and what the run judged, archived and left open for another driver. */
function readDriven(driven: WorkflowEnvelope, ran: RunState, into: Finished): void {
  const open = { passes: 0, sessions: 0 };
  const held = 'error' in driven && driven.error.code === 'confined_pending' ? driven.error.message : undefined;

  if ('error' in driven && held === undefined) into.broke.push(`Run ${ran.id} of ${FINISHED_WORKFLOW} stopped: ${driven.error.code}: ${driven.error.message}`);
  readFinished(ran, { into, open });

  if (open.passes + open.sessions > 0) into.held.push({ run: ran.id, ...open, reason: held ?? 'no driver here took it' });

  if (ran.status === 'failed') into.broke.push(`Run ${ran.id} of ${FINISHED_WORKFLOW} failed: ${failedSteps(ran)}.`);
}

/**
 * Starts teamai-finished-sessions in `config`, as the CLI's own start, and drives it here, unless a run of it already
 * works on this data home or nothing waits for one. Says what the run judged, archived and left open.
 */
async function finishSessions(config: LocalConfig, mode: RunMode): Promise<Finished> {
  const finished = nothing();
  const unavailable = scoringUnavailable(config);

  if (unavailable) log.warn(unavailable);
  const started = await FinishedSessions.start(config, { client: inProcessClient({ config, env: await resolveWorkflowEnv(config) }), mode });

  switch (started.kind) {
    case 'idle':
      return finished;
    case 'working':
      finished.working.push(started.run);

      return finished;
    case 'failed':
      finished.broke.push(`${FINISHED_WORKFLOW} did not start: ${started.failure.code}: ${started.failure.message}`);

      return finished;
    case 'started':
      break;
    default: {
      const unhandled: never = started;

      return unhandled;
    }
  }

  const team = await loadTeamConfig(config.repo.localPath);
  const driven = await runLocalDriver(config, started.run, started.cwd, { toolPaths: team?.toolPaths });
  const ran = await readRun(config, started.run);

  if (ran === 'missing' || ran === 'corrupt') finished.broke.push(`Run ${started.run} of ${FINISHED_WORKFLOW} could not be read after it was driven (${ran}).`);
  else readDriven(driven, ran, finished);

  return finished;
}

/** Publishes the workflow run records of `config` that a run queued and could not publish, as pull does. */
async function publishRunRecords(config: LocalConfig): Promise<Pick<DrainResult, 'runRecordsPublished' | 'unpublished'>> {
  const runs = new Set((await pendingRecords(config)).map((record) => record.run)).size;

  if (runs === 0) return { runRecordsPublished: 0, unpublished: [] };
  const delivery = await publishPendingRecords(config);

  switch (delivery.state) {
    case 'published':
      return { runRecordsPublished: runs, unpublished: [] };
    case 'pending':
      return { runRecordsPublished: 0, unpublished: [{ kind: 'runRecords', count: runs, reason: delivery.reason }] };
    default: {
      const unhandled: never = delivery;

      return unhandled;
    }
  }
}

/** Publishes the pending labels of `config`, as `score --push` does. Nothing is pending while usage reporting is off. */
async function publishLabels(config: LocalConfig): Promise<Pick<DrainResult, 'labelsPublished' | 'unpublished'>> {
  const pending = await LabelStore.unpublished(config);

  if (pending === 0) return { labelsPublished: 0, unpublished: [] };
  const delivery = await LabelStore.publish(config);

  switch (delivery.state) {
    case 'published':
      return { labelsPublished: pending, unpublished: [] };
    case 'pending':
      return { labelsPublished: 0, unpublished: [{ kind: 'labels', count: pending, reason: delivery.reason }] };
    case 'unsupported':
      return { labelsPublished: 0, unpublished: [] };
    default: {
      const unhandled: never = delivery;

      return unhandled;
    }
  }
}

/** Drains each scope of `configs`, in order, in run mode `mode`. */
async function run(configs: readonly LocalConfig[], { mode, clock = () => new Date().toISOString() }: { mode: RunMode; clock?: () => string }): Promise<DrainResult> {
  const result: DrainResult = { ...nothing(), runRecordsPublished: 0, labelsPublished: 0, steps: [], usage: [] };

  for (const config of configs) {
    const team = await loadTeamConfig(config.repo.localPath);

    if (mode === 'unattended') await finishUnattended(config, clock());
    const finished = await finishSessions(config, mode);
    result.judged.push(...finished.judged);
    result.failed.push(...finished.failed);
    result.held.push(...finished.held);
    result.ciPending.passes += finished.ciPending.passes;
    result.ciPending.sessions += finished.ciPending.sessions;
    result.working.push(...finished.working);
    result.broke.push(...finished.broke);
    result.capturedArchived += finished.capturedArchived;
    result.unpublished.push(...finished.unpublished);
    const records = await publishRunRecords(config);
    result.runRecordsPublished += records.runRecordsPublished;
    result.unpublished.push(...records.unpublished);
    const labels = await publishLabels(config);
    result.labelsPublished += labels.labelsPublished;
    result.unpublished.push(...labels.unpublished);

    if (SessionPolicy.publish(config, team).policies[mode].policy === 'auto') {
      const steps = await SessionPublish.steps(config, mode, clock());
      result.steps.push(...steps);
      result.unpublished.push(...steps.flatMap(({ unpublished }) => (unpublished ? [{ kind: 'sessions' as const, count: unpublished.sessions, reason: unpublished.reason }] : [])));
    }

    // As pull reports it, so the counts of this data home leave an ephemeral runner.
    if (usesBranchWorktree(config) && isUsageReportEnabled(config, team ?? {})) {
      const outcome = await reportUsage(config.repo.localPath, config.username, { selfConfig: config, drain: { running: await agentSessionIdFromEnv() } });

      if (outcome !== 'nothing') result.usage.push({ member: config.username, reported: outcome === 'reported' });
    }
  }

  return result;
}

/**
 * Whether the local driver drains `config` at the end of an unattended run: while its unattended `sessions.publish` or
 * unattended session scoring is not `off`. With both `off` it does nothing more than before #1385.
 */
async function drainsUnattendedRun(config: LocalConfig): Promise<boolean> {
  if (SessionPolicy.publish(config, await loadTeamConfig(config.repo.localPath)).policies.unattended.policy !== 'off') return true;
  const scoring = scoringUnavailable(config) ? undefined : await scopeScoring(config);

  return scoring?.ok === true && scoring.sessions.policies.unattended.policy !== 'off';
}

const plural = ({ count, one, many }: { count: number; one: string; many: string }) => `${count} ${count === 1 ? one : many}`;

/** The scorers of `judged`, each once, in the order they were first judged. */
const scorerNames = (judged: readonly Judged[]) => [...new Set(judged.flatMap((one) => one.scorers))].join(', ');

/** `passes` passes and `sessions` sessions, leaving out a kind there is none of. */
function passesAndSessions({ passes, sessions }: { passes: number; sessions: number }): string {
  return [passes > 0 ? plural({ count: passes, one: 'pass', many: 'passes' }) : '', sessions > 0 ? plural({ count: sessions, one: 'session', many: 'sessions' }) : ''].filter(Boolean).join(' and ');
}

/** Why `failed` failed, and the command a person runs for a new judgment. */
function failedText({ scorers, subject, code }: FailedJudgment): string {
  const flags = scorers.map((scorer) => `--scorer ${scorer}`).join(' ');

  const [what, ask] = 'sessionId' in subject
    ? [`${subject.platform} session ${subject.sessionId}`, `teamai score --session ${subject.sessionId} --source ${subject.platform} ${flags}`]
    : [`pass ${subject.pass} of step ${subject.step} in run ${subject.runId}`, `teamai score --run ${subject.runId} --step ${subject.step} --pass ${subject.pass} ${flags}`];

  return `${scorers.join(', ')} on ${what}: ${code}. A failed judgment is final and is not retried. To ask for a new one: ${ask}`;
}

/** What could not reach teamai-reports, each reason once, and that the next drain retries it. */
function unpublishedText(unpublished: readonly Unpublished[]): string {
  const count = (kind: Unpublished['kind']) => unpublished.filter((entry) => entry.kind === kind).reduce((sum, entry) => sum + entry.count, 0);
  const [runRecords, labels, sessions] = [count('runRecords'), count('labels'), count('sessions')];

  const kinds = [
    runRecords > 0 ? plural({ count: runRecords, one: 'workflow run record', many: 'workflow run records' }) : '',
    labels > 0 ? plural({ count: labels, one: 'label', many: 'labels' }) : '',
    sessions > 0 ? plural({ count: sessions, one: 'session', many: 'sessions' }) : '',
  ].filter(Boolean);

  const what = kinds.length > 1 ? `${kinds.slice(0, -1).join(', ')} and ${kinds.at(-1)}` : kinds.join('');
  // A reason can end a sentence of its own, as the cause ssh gives does.
  const reasons = [...new Set(unpublished.map((entry) => entry.reason.replace(/\.$/, '')))].join('; ');

  return `Could not publish ${what} to teamai-reports: ${reasons}. ${runRecords + labels + sessions === 1 ? 'It stays' : 'They stay'} pending; run teamai score --drain again.`;
}

/** Whether a judgment or a publish the drain tried here failed, so its command exits 1. */
function hasFailed(result: DrainResult): boolean {
  return result.failed.length > 0 || result.broke.length > 0 || result.unpublished.length > 0 || result.usage.some((usage) => !usage.reported);
}

/** Prints what `result` did, one line per kind of work. */
function print(result: DrainResult): void {
  const passes = result.judged.filter((one) => one.source === 'workflow');
  const sessions = result.judged.filter((one) => one.source === 'session');

  if (passes.length > 0) log.success(`Judged ${plural({ count: passes.length, one: 'sampled pass', many: 'sampled passes' })} here (${scorerNames(passes)})`);

  if (sessions.length > 0) log.success(`Judged ${plural({ count: sessions.length, one: 'sampled session', many: 'sampled sessions' })} here (${scorerNames(sessions)})`);

  for (const failed of result.failed) log.error(failedText(failed));

  if (result.runRecordsPublished > 0) log.success(`Published ${plural({ count: result.runRecordsPublished, one: 'workflow run record', many: 'workflow run records' })} to teamai-reports`);

  if (result.labelsPublished > 0) log.success(`Published ${plural({ count: result.labelsPublished, one: 'label', many: 'labels' })} to teamai-reports`);

  if (result.capturedArchived > 0) log.success(`Archived ${plural({ count: result.capturedArchived, one: 'captured session', many: 'captured sessions' })} to teamai-reports (scrubbed)`);

  for (const { run: runId, archived, skipped } of result.steps) {
    if (archived > 0) log.success(`Archived ${plural({ count: archived, one: 'step session', many: 'step sessions' })} of ${runId} to teamai-reports (scrubbed)`);

    for (const reason of new Set(skipped.map((pass) => pass.reason))) {
      const skippedPasses = skipped.filter((pass) => pass.reason === reason);
      log.info(`Skipped ${plural({ count: skippedPasses.length, one: 'step session', many: 'step sessions' })} of ${runId}: ${reason} (${skippedPasses.map((pass) => `${pass.step}, pass ${pass.pass}`).join('; ')})`);
    }
  }

  if (result.unpublished.length > 0) log.error(unpublishedText(result.unpublished));

  for (const { member, reported } of result.usage) {
    if (reported) log.success(`Reported usage to stats/${member}.yaml`);
    else log.error(`Could not report usage to stats/${member}.yaml on teamai-reports. It stays on this machine; run teamai score --drain again.`);
  }

  for (const broke of result.broke) log.error(broke);

  for (const { run: runId, passes: heldPasses, sessions: heldSessions, reason } of result.held) {
    const what = passesAndSessions({ passes: heldPasses, sessions: heldSessions });
    const them = heldPasses + heldSessions === 1 ? 'it' : 'them';
    log.info(`Left open: the judge of ${what} in run ${runId}: ${reason.replace(/\.$/u, '')}. A driver whose tools judge ${them} takes ${them} with: teamai workflow next ${runId} --json '{"driver":{…,"can":{…}}}'`);
  }

  const ci = passesAndSessions(result.ciPending);

  if (ci !== '') log.info(`Left open: ${ci} whose CI has not finished. The next teamai score --drain labels them once it has.`);

  for (const runId of result.working) log.info(`Left open: run ${runId} of ${FINISHED_WORKFLOW} is already working here. Run teamai score --drain again once it ends.`);

  if (result.held.length === 0 && ci === '' && result.working.length === 0 && !hasFailed(result)) log.success('Nothing left to do here');
}

export const Drain = { run, print, hasFailed, drainsUnattendedRun } as const;
