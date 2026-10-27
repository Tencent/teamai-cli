/**
 * `teamai score --drain` (#1385): what every driver runs before an unattended job ends, and the local driver at the end
 * of an unattended run. It judges the judge work this machine can run, publishes labels and sessions, reports usage, and
 * says what is left for other drivers.
 */
import { loadTeamConfig } from './config.js';
import { driverIdentity } from './driver-identity.js';
import type { RunMode } from './launch-context.js';
import { judgePassLock, localJudgeOffers } from './score-sessions.js';
import { scoringUnavailable } from './scorers/home.js';
import { scopeScoring } from './scorers/settings.js';
import { SessionCaptures } from './session-flow/captures.js';
import { SessionPolicy } from './session-flow/session-policy.js';
import { SessionPublish, type StepSessionsPublished } from './session-flow/session-publish.js';
import { SessionWork } from './session-flow/session-work.js';
import type { RunSubject, SessionSubject } from './scorers/label.js';
import { LabelStore } from './scorers/label-store.js';
import { reportUsage } from './team-push.js';
import { isUsageReportEnabled, usesBranchWorktree, type LocalConfig } from './types.js';
import { acquireLock, releaseLock } from './update.js';
import { log } from './utils/logger.js';
import { agentSessionIdFromEnv } from './utils/session-id.js';
import { pendingRecords, publishPendingRecords } from './workflow/records.js';
import { judgeLease, openJudgeEntries, submitJudgeLease, takeJudgeLease, type SkippedEntry, type TakenLease } from './workflow/scoring.js';

/** A lease judged here: a workflow pass or a session, by the scorers it carried. */
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

/** What one drain did across its scopes. */
export interface DrainResult {
  judged: Judged[];
  failed: FailedJudgment[];
  /** Judge entries no judge tool here runs the scorer's model for, left open for another driver's `score --next`. */
  leftOpen: SkippedEntry[];
  /** How many judge entries need an isolation no judge tool here reaches, left open for another driver. */
  unmetIsolation: number;
  /** How many judge entries are open while no judge tool is installed here, left open for another driver. */
  noJudgeTool: number;
  /** How many judge entries are open while another judge pass on this machine runs, left open for it or the next drain. */
  otherPassRunning: number;
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

/** In unattended mode, every session captured unattended in this data home is finished from now on. */
async function finishUnattended(config: LocalConfig, now: string): Promise<void> {
  for (const captured of await SessionCaptures.list(config)) {
    if (SessionCaptures.runModeOf(captured.captures) === 'unattended' && !captured.drained) await SessionCaptures.markDrained(config, captured, now);
  }
}

type Lease = Extract<TakenLease, { kind: 'lease' }>['lease'];

const scorersOf = (lease: Lease): readonly string[] => ('scorers' in lease ? lease.scorers : [lease.scorer]);

/**
 * Judges every judge entry of `config` a local judge tool here can take, with labels left pending, and says which
 * entries the last offer, the least strict, left for another driver. A pass lease whose judgment failed is settled as
 * failed, so it is not handed back; a session lease closed when its judge failed. A lease handed back all the same,
 * because that settle found the attempts locked, ends the offer: one drain judges a lease once. While another judge pass
 * here holds `judgePassLock`, it judges nothing, so it neither releases nor takes back a lease that pass holds.
 */
async function judge(config: LocalConfig, clock: () => string): Promise<Pick<DrainResult, 'judged' | 'failed' | 'leftOpen' | 'unmetIsolation' | 'noJudgeTool' | 'otherPassRunning'>> {
  const driver = driverIdentity('local', SessionWork.leaseCwd(config));
  const judged: Judged[] = [];
  const failed: FailedJudgment[] = [];
  let leftOpen: SkippedEntry[] = [];
  let unmetIsolation = 0;
  const tried = new Set<string>();
  // Its scores would land inside the repository, the lock with them.
  const unavailable = scoringUnavailable(config);
  if (unavailable) {
    log.warn(unavailable);
    return { judged, failed, leftOpen, unmetIsolation, noJudgeTool: 0, otherPassRunning: 0 };
  }
  const offers = await localJudgeOffers();
  if (offers.length === 0) return { judged, failed, leftOpen, unmetIsolation, noJudgeTool: await openJudgeEntries(config, clock()), otherPassRunning: 0 };
  const lock = judgePassLock(config);
  if (!await acquireLock(lock)) return { judged, failed, leftOpen, unmetIsolation, noJudgeTool: 0, otherPassRunning: await openJudgeEntries(config, clock()) };
  try {
    for (const offer of offers) {
      for (;;) {
        const taken = await takeJudgeLease(config, { driver, judge: offer, running: [] }, clock());
        // Of the open entries an idle answer counts, those it did not skip for their model need more isolation.
        if (taken.kind === 'idle') [leftOpen, unmetIsolation] = [taken.skipped, taken.open - taken.skipped.length];
        if (taken.kind !== 'lease' || tried.has(taken.lease.ref)) break;
        const { lease } = taken;
        tried.add(lease.ref);
        const settled = await judgeLease(config, lease.ref, driver, { clock, publish: false });
        if (!('error' in settled)) {
          judged.push({ source: lease.source, scorers: settled.attempts.map((attempt) => attempt.scorer) });
          continue;
        }
        failed.push({ scorers: scorersOf(lease), subject: lease.subject, code: settled.error.code });
        if (lease.source === 'workflow') await submitJudgeLease(config, lease.ref, { driver, outcome: 'failed' }, clock());
      }
    }
  } finally {
    await releaseLock(lock);
  }
  return { judged, failed, leftOpen, unmetIsolation, noJudgeTool: 0, otherPassRunning: 0 };
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
  const result: DrainResult = { judged: [], failed: [], leftOpen: [], unmetIsolation: 0, noJudgeTool: 0, otherPassRunning: 0, runRecordsPublished: 0, labelsPublished: 0, capturedArchived: 0, steps: [], unpublished: [], usage: [] };
  for (const config of configs) {
    const team = await loadTeamConfig(config.repo.localPath);
    if (mode === 'unattended') await finishUnattended(config, clock());
    const { judged, failed, leftOpen, unmetIsolation, noJudgeTool, otherPassRunning } = await judge(config, clock);
    result.judged.push(...judged);
    result.failed.push(...failed);
    result.leftOpen.push(...leftOpen);
    result.unmetIsolation += unmetIsolation;
    result.noJudgeTool += noJudgeTool;
    result.otherPassRunning += otherPassRunning;
    const records = await publishRunRecords(config);
    result.runRecordsPublished += records.runRecordsPublished;
    result.unpublished.push(...records.unpublished);
    const labels = await publishLabels(config);
    result.labelsPublished += labels.labelsPublished;
    result.unpublished.push(...labels.unpublished);
    if (SessionPolicy.publish(config, team).policies[mode].policy === 'auto') {
      const captured = await SessionPublish.captured(config, mode, clock());
      result.capturedArchived += captured.archived;
      result.unpublished.push(...captured.unpublished.map(({ sessions, reason }) => ({ kind: 'sessions' as const, count: sessions, reason })));
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
  return result.failed.length > 0 || result.unpublished.length > 0 || result.usage.some((usage) => !usage.reported);
}

/** Prints, when `count` entries are left open, `what` they are and how a driver that `driver` describes takes them. */
function printLeftOpen({ count, what, driver }: { count: number; what: string; driver: (them: 'it' | 'them') => string }): void {
  if (count === 0) return;
  const them = count === 1 ? 'it' : 'them';
  log.info(`Left open: ${what}. A driver ${driver(them)} takes ${them} with: teamai score --next --json '{"driver":{…,"can":{"judge":{…}}}}'`);
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
      const passes = skipped.filter((pass) => pass.reason === reason);
      log.info(`Skipped ${plural({ count: passes.length, one: 'step session', many: 'step sessions' })} of ${runId}: ${reason} (${passes.map((pass) => `${pass.step}, pass ${pass.pass}`).join('; ')})`);
    }
  }
  if (result.unpublished.length > 0) log.error(unpublishedText(result.unpublished));
  for (const { member, reported } of result.usage) {
    if (reported) log.success(`Reported usage to stats/${member}.yaml`);
    else log.error(`Could not report usage to stats/${member}.yaml on teamai-reports. It stays on this machine; run teamai score --drain again.`);
  }
  const { leftOpen, unmetIsolation, noJudgeTool, otherPassRunning } = result;
  const ofSessions = leftOpen.filter((entry) => 'sessionId' in entry.subject).length;
  printLeftOpen({
    count: leftOpen.length,
    what: `${passesAndSessions({ passes: leftOpen.length - ofSessions, sessions: ofSessions })} whose scorer pins a model no judge tool here runs (judge_model_unavailable)`,
    driver: (them) => `whose tools run ${them}`,
  });
  printLeftOpen({
    count: unmetIsolation,
    what: `${plural({ count: unmetIsolation, one: 'entry that needs', many: 'entries that need' })} an isolation no judge tool here reaches`,
    driver: () => 'whose judge reaches it',
  });
  printLeftOpen({
    count: noJudgeTool,
    what: `${plural({ count: noJudgeTool, one: 'judge entry', many: 'judge entries' })}: no judge tool is installed here`,
    driver: (them) => `whose tools judge ${them}`,
  });
  if (otherPassRunning > 0) {
    log.info(`Left open: ${plural({ count: otherPassRunning, one: 'judge entry', many: 'judge entries' })}: another judge pass on this machine is running. Run teamai score --drain again once it ends.`);
  }
  if (leftOpen.length === 0 && unmetIsolation === 0 && noJudgeTool === 0 && otherPassRunning === 0 && !hasFailed(result)) log.success('Nothing left to do here');
}

export const Drain = { run, print, hasFailed, drainsUnattendedRun } as const;
