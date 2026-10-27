/**
 * `teamai score --drain` (#1385): what every driver runs before an unattended job ends, and the local driver at the end
 * of an unattended run. It judges the judge work this machine can run, publishes labels and sessions, reports usage, and
 * says what is left for other drivers.
 */
import { loadTeamConfig } from './config.js';
import { driverIdentity } from './driver-identity.js';
import type { RunMode } from './launch-context.js';
import { localJudgeOffers } from './score-sessions.js';
import { SessionCaptures } from './session-flow/captures.js';
import { SessionPolicy } from './session-flow/session-policy.js';
import { SessionPublish, type StepSessionsPublished } from './session-flow/session-publish.js';
import { SessionWork } from './session-flow/session-work.js';
import type { RunSubject, SessionSubject } from './scorers/label.js';
import { LabelStore } from './scorers/label-store.js';
import { reportUsage } from './team-push.js';
import { isUsageReportEnabled, usesBranchWorktree, type LocalConfig } from './types.js';
import { log } from './utils/logger.js';
import { pendingRecords, publishPendingRecords } from './workflow/records.js';
import { judgeLease, submitJudgeLease, takeJudgeLease, type SkippedEntry, type TakenLease } from './workflow/scoring.js';

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

/** What could not reach teamai-reports, and why. It stays pending, and the next drain retries it. */
interface Unpublished {
  runRecords: number;
  labels: number;
  sessions: number;
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
 * because that settle found the attempts locked, ends the offer: one drain judges a lease once.
 */
async function judge(config: LocalConfig, clock: () => string): Promise<Pick<DrainResult, 'judged' | 'failed' | 'leftOpen' | 'unmetIsolation'>> {
  const driver = driverIdentity('local', SessionWork.leaseCwd(config));
  const judged: Judged[] = [];
  const failed: FailedJudgment[] = [];
  let leftOpen: SkippedEntry[] = [];
  let unmetIsolation = 0;
  const tried = new Set<string>();
  for (const offer of await localJudgeOffers()) {
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
  return { judged, failed, leftOpen, unmetIsolation };
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
      return { runRecordsPublished: 0, unpublished: [{ runRecords: runs, labels: 0, sessions: 0, reason: delivery.reason }] };
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
      return { labelsPublished: 0, unpublished: [{ runRecords: 0, labels: pending, sessions: 0, reason: delivery.reason }] };
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
  const result: DrainResult = { judged: [], failed: [], leftOpen: [], unmetIsolation: 0, runRecordsPublished: 0, labelsPublished: 0, capturedArchived: 0, steps: [], unpublished: [], usage: [] };
  for (const config of configs) {
    const team = await loadTeamConfig(config.repo.localPath);
    if (mode === 'unattended') await finishUnattended(config, clock());
    const { judged, failed, leftOpen, unmetIsolation } = await judge(config, clock);
    result.judged.push(...judged);
    result.failed.push(...failed);
    result.leftOpen.push(...leftOpen);
    result.unmetIsolation += unmetIsolation;
    const records = await publishRunRecords(config);
    result.runRecordsPublished += records.runRecordsPublished;
    result.unpublished.push(...records.unpublished);
    const labels = await publishLabels(config);
    result.labelsPublished += labels.labelsPublished;
    result.unpublished.push(...labels.unpublished);
    if (SessionPolicy.publish(config, team).policies[mode].policy === 'auto') {
      const captured = await SessionPublish.captured(config, mode, clock());
      result.capturedArchived += captured.archived;
      result.unpublished.push(...captured.unpublished.map(({ sessions, reason }) => ({ runRecords: 0, labels: 0, sessions, reason })));
      const steps = await SessionPublish.steps(config, mode, clock());
      result.steps.push(...steps);
      result.unpublished.push(...steps.flatMap(({ unpublished }) => (unpublished ? [{ runRecords: 0, labels: 0, ...unpublished }] : [])));
    }
    // As pull reports it, so the counts of this data home leave an ephemeral runner.
    if (usesBranchWorktree(config) && isUsageReportEnabled(config, team ?? {})) {
      const outcome = await reportUsage(config.repo.localPath, config.username, { selfConfig: config });
      if (outcome !== 'nothing') result.usage.push({ member: config.username, reported: outcome === 'reported' });
    }
  }
  return result;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The scorers of `judged`, each once, in the order they were first judged. */
const scorerNames = (judged: readonly Judged[]) => [...new Set(judged.flatMap((one) => one.scorers))].join(', ');

/** `passes` passes and `sessions` sessions, leaving out a kind there is none of. */
function passesAndSessions(passes: number, sessions: number): string {
  return [passes > 0 ? plural(passes, 'pass', 'passes') : '', sessions > 0 ? plural(sessions, 'session', 'sessions') : ''].filter(Boolean).join(' and ');
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
  const runRecords = unpublished.reduce((sum, entry) => sum + entry.runRecords, 0);
  const labels = unpublished.reduce((sum, entry) => sum + entry.labels, 0);
  const sessions = unpublished.reduce((sum, entry) => sum + entry.sessions, 0);
  const kinds = [
    runRecords > 0 ? plural(runRecords, 'workflow run record', 'workflow run records') : '',
    labels > 0 ? plural(labels, 'label', 'labels') : '',
    sessions > 0 ? plural(sessions, 'session', 'sessions') : '',
  ].filter(Boolean);
  const what = kinds.length > 1 ? `${kinds.slice(0, -1).join(', ')} and ${kinds.at(-1)}` : kinds.join('');
  const reasons = [...new Set(unpublished.map((entry) => entry.reason))].join('; ');
  return `Could not publish ${what} to teamai-reports: ${reasons}. ${runRecords + labels + sessions === 1 ? 'It stays' : 'They stay'} pending; run teamai score --drain again.`;
}

/** Whether a judgment or a publish the drain tried here failed, so its command exits 1. */
function hasFailed(result: DrainResult): boolean {
  return result.failed.length > 0 || result.unpublished.length > 0 || result.usage.some((usage) => !usage.reported);
}

/** Prints what `result` did, one line per kind of work. */
function print(result: DrainResult): void {
  const passes = result.judged.filter((one) => one.source === 'workflow');
  const sessions = result.judged.filter((one) => one.source === 'session');
  if (passes.length > 0) log.success(`Judged ${plural(passes.length, 'sampled pass', 'sampled passes')} here (${scorerNames(passes)})`);
  if (sessions.length > 0) log.success(`Judged ${plural(sessions.length, 'sampled session', 'sampled sessions')} here (${scorerNames(sessions)})`);
  for (const failed of result.failed) log.error(failedText(failed));
  if (result.runRecordsPublished > 0) log.success(`Published ${plural(result.runRecordsPublished, 'workflow run record', 'workflow run records')} to teamai-reports`);
  if (result.labelsPublished > 0) log.success(`Published ${plural(result.labelsPublished, 'label', 'labels')} to teamai-reports`);
  if (result.capturedArchived > 0) log.success(`Archived ${plural(result.capturedArchived, 'captured session', 'captured sessions')} to teamai-reports (scrubbed)`);
  for (const { run: runId, archived, skipped } of result.steps) {
    if (archived > 0) log.success(`Archived ${plural(archived, 'step session', 'step sessions')} of ${runId} to teamai-reports (scrubbed)`);
    for (const reason of new Set(skipped.map((pass) => pass.reason))) {
      const passes = skipped.filter((pass) => pass.reason === reason);
      log.info(`Skipped ${plural(passes.length, 'step session', 'step sessions')} of ${runId}: ${reason} (${passes.map((pass) => `${pass.step}, pass ${pass.pass}`).join('; ')})`);
    }
  }
  if (result.unpublished.length > 0) log.error(unpublishedText(result.unpublished));
  for (const { member, reported } of result.usage) {
    if (reported) log.success(`Reported usage to stats/${member}.yaml`);
    else log.error(`Could not report usage to stats/${member}.yaml on teamai-reports. It stays on this machine; run teamai score --drain again.`);
  }
  const { leftOpen } = result;
  if (leftOpen.length > 0) {
    const ofSessions = leftOpen.filter((entry) => 'sessionId' in entry.subject).length;
    log.info(`Left open: ${passesAndSessions(leftOpen.length - ofSessions, ofSessions)} whose scorer pins a model no judge tool here runs (judge_model_unavailable). `
      + `A driver whose tools run ${leftOpen.length === 1 ? 'it' : 'them'} takes ${leftOpen.length === 1 ? 'it' : 'them'} with: teamai score --next --json '{"driver":{…,"can":{"judge":{…}}}}'`);
  }
  const { unmetIsolation } = result;
  if (unmetIsolation > 0) {
    log.info(`Left open: ${plural(unmetIsolation, 'entry that needs', 'entries that need')} an isolation no judge tool here reaches. `
      + `A driver whose judge reaches it takes ${unmetIsolation === 1 ? 'it' : 'them'} with: teamai score --next --json '{"driver":{…,"can":{"judge":{…}}}}'`);
  }
  if (leftOpen.length === 0 && unmetIsolation === 0 && !hasFailed(result)) log.success('Nothing left to do here');
}

export const Drain = { run, print, hasFailed } as const;
