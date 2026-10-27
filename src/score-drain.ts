/**
 * `teamai score --drain` (#1385): what every driver runs before an unattended job ends, and the local driver at the end
 * of an unattended run. It judges the judge work this machine can run, publishes labels and sessions, reports usage, and
 * says what is left for other drivers.
 */
import { driverIdentity } from './driver-identity.js';
import type { RunMode } from './launch-context.js';
import { localJudgeOffers } from './score-sessions.js';
import { SessionCaptures } from './session-flow/captures.js';
import { SessionWork } from './session-flow/session-work.js';
import type { RunSubject, SessionSubject } from './scorers/label.js';
import type { LocalConfig } from './types.js';
import { log } from './utils/logger.js';
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

/** What one drain did across its scopes. */
export interface DrainResult {
  judged: Judged[];
  failed: FailedJudgment[];
  /** Judge entries no judge tool here runs the scorer's model for, left open for another driver's `score --next`. */
  leftOpen: SkippedEntry[];
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
async function judge(config: LocalConfig, clock: () => string): Promise<Pick<DrainResult, 'judged' | 'failed' | 'leftOpen'>> {
  const driver = driverIdentity('local', SessionWork.leaseCwd(config));
  const judged: Judged[] = [];
  const failed: FailedJudgment[] = [];
  let leftOpen: SkippedEntry[] = [];
  const tried = new Set<string>();
  for (const offer of await localJudgeOffers()) {
    for (;;) {
      const taken = await takeJudgeLease(config, { driver, judge: offer, running: [] }, clock());
      if (taken.kind === 'idle') leftOpen = taken.skipped;
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
  return { judged, failed, leftOpen };
}

/** Drains each scope of `configs`, in order, in run mode `mode`. */
async function run(configs: readonly LocalConfig[], { mode, clock = () => new Date().toISOString() }: { mode: RunMode; clock?: () => string }): Promise<DrainResult> {
  const result: DrainResult = { judged: [], failed: [], leftOpen: [] };
  for (const config of configs) {
    if (mode === 'unattended') await finishUnattended(config, clock());
    const { judged, failed, leftOpen } = await judge(config, clock);
    result.judged.push(...judged);
    result.failed.push(...failed);
    result.leftOpen.push(...leftOpen);
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

/** Whether something the drain tried here failed, so its command exits 1. */
function hasFailed(result: DrainResult): boolean {
  return result.failed.length > 0;
}

/** Prints what `result` did, one line per kind of work. */
function print(result: DrainResult): void {
  const passes = result.judged.filter((one) => one.source === 'workflow');
  const sessions = result.judged.filter((one) => one.source === 'session');
  if (passes.length > 0) log.success(`Judged ${plural(passes.length, 'sampled pass', 'sampled passes')} here (${scorerNames(passes)})`);
  if (sessions.length > 0) log.success(`Judged ${plural(sessions.length, 'sampled session', 'sampled sessions')} here (${scorerNames(sessions)})`);
  for (const failed of result.failed) log.error(failedText(failed));
  const { leftOpen } = result;
  if (leftOpen.length > 0) {
    const ofSessions = leftOpen.filter((entry) => 'sessionId' in entry.subject).length;
    log.info(`Left open: ${passesAndSessions(leftOpen.length - ofSessions, ofSessions)} whose scorer pins a model no judge tool here runs (judge_model_unavailable). `
      + `A driver whose tools run ${leftOpen.length === 1 ? 'it' : 'them'} takes ${leftOpen.length === 1 ? 'it' : 'them'} with: teamai score --next --json '{"driver":{…,"can":{"judge":{…}}}}'`);
  }
  if (leftOpen.length === 0 && !hasFailed(result)) log.success('Nothing left to do here');
}

export const Drain = { run, print, hasFailed } as const;
