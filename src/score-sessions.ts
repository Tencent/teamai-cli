/**
 * `teamai score-sessions` (#1179): the local driver that works on this machine's finished attended sessions in the
 * background, started detached after a session start's pull. Where `sessions.publish` is `auto` for attended sessions it
 * archives them (#1385). Where their scoring is `auto` it takes session work only, through the same leases as any
 * driver, judges each with a local tool, and leaves the labels pending for the next pull to publish.
 */
import path from 'node:path';
import { detectProjectConfig, loadLocalConfig, loadTeamConfig } from './config.js';
import { driverIdentity } from './driver-identity.js';
import { scoresDir } from './scorers/attempts.js';
import { scoringUnavailable } from './scorers/home.js';
import { judgeToolLevels } from './scorers/judge.js';
import type { Isolation } from './scorers/label.js';
import { scopeScoring } from './scorers/settings.js';
import { SessionPolicy } from './session-flow/session-policy.js';
import { SessionPublish } from './session-flow/session-publish.js';
import { SessionWork } from './session-flow/session-work.js';
import { getDataHome, type LocalConfig } from './types.js';
import { acquireLock, releaseLock } from './update.js';
import { pathExists } from './utils/fs.js';
import { log } from './utils/logger.js';
import { readWorkspaceChildren } from './workspace-children.js';
import { judgeLease, takeJudgeLease } from './workflow/scoring.js';

/** How long one run takes new work for; a judge it started then still finishes. */
const RUN_MAX_MS = 30 * 60 * 1000;

/**
 * What the local judge tools can offer, strictest first: those whose profile reaches `verified`, then every installed
 * tool at `best-effort`. A tool is never offered at a level it cannot reach, since its judge would refuse the lease.
 */
export async function localJudgeOffers(): Promise<Array<{ isolation: Isolation; tools: [string, ...string[]] }>> {
  const levels = await judgeToolLevels();
  const offers: Array<{ isolation: Isolation; tools: [string, ...string[]] }> = [];
  const [verified, ...moreVerified] = levels.filter((level) => level.isolation === 'verified').map((level) => level.tool);
  if (verified) offers.push({ isolation: 'verified', tools: [verified, ...moreVerified] });
  const [any, ...more] = levels.map((level) => level.tool);
  if (any) offers.push({ isolation: 'best-effort', tools: [any, ...more] });
  return offers;
}

/**
 * The lock a pass that judges the entries of `config` here holds: the background pass, and the judging of a drain. Both
 * take leases as the same local driver, so a lease one holds would read as the other's own.
 */
export const judgePassLock = (config: LocalConfig): string => path.join(scoresDir(config), 'score-sessions.lock');

/** What the background pass does with the attended sessions of `config`: judge them, publish them, both or neither. */
async function attendedWork(config: LocalConfig): Promise<{ judges: boolean; publishes: boolean }> {
  const scoring = scoringUnavailable(config) ? undefined : await scopeScoring(config);
  return {
    judges: scoring?.ok === true && scoring.sessions.policies.attended.policy === 'auto',
    publishes: SessionPolicy.publish(config, await loadTeamConfig(config.repo.localPath)).policies.attended.policy === 'auto',
  };
}

/**
 * For each scope in `configs`, in order: archives its finished attended sessions where `sessions.publish` is `auto` for
 * them, then judges its finished sessions where attended session scoring is `auto`, until none is left, the day's limit
 * is spent, or 30 minutes passed since it started. A scope another run works on is left to it.
 */
export async function scoreSessions(configs: readonly LocalConfig[], { clock = () => new Date().toISOString() }: { clock?: () => string } = {}): Promise<void> {
  const deadline = Date.parse(clock()) + RUN_MAX_MS;
  const offers = await localJudgeOffers();
  for (const config of configs) {
    const { judges, publishes } = await attendedWork(config);
    if (!judges && !publishes) continue;
    const lock = judgePassLock(config);
    if (!await acquireLock(lock)) continue;
    try {
      if (publishes) {
        const published = await SessionPublish.captured(config, 'attended', clock());
        for (const { sessions, reason } of published.unpublished) log.debug(`[sessions] ${sessions} attended session(s) were not archived: ${reason}`);
      }
      if (!judges) continue;
      const driver = driverIdentity('local', SessionWork.leaseCwd(config));
      for (const judge of offers) {
        for (;;) {
          const now = clock();
          if (Date.parse(now) >= deadline) return;
          const taken = await takeJudgeLease(config, { driver, judge, running: [], only: 'session' }, now);
          if (taken.kind !== 'lease') break;
          const judged = await judgeLease(config, taken.lease.ref, driver, { clock, publish: false });
          if ('error' in judged) log.debug(`[scores] Session lease ${taken.lease.ref} was not labelled: ${judged.error.code}: ${judged.error.message}`);
        }
      }
    } finally {
      await releaseLock(lock);
    }
  }
}

/**
 * The scopes `cwd` reaches: its project scope, with its workspace children, whose namespaces set scoring too, then the
 * user scope, each data home once. A directory that no longer exists reaches the user scope only.
 */
export async function reachedScopes(cwd?: string): Promise<LocalConfig[]> {
  const detected = cwd === undefined || await pathExists(cwd) ? await detectProjectConfig(cwd).catch(() => null) : null;
  const project = detected && await readWorkspaceChildren(detected);
  const user = await loadLocalConfig();
  const homes = new Set<string>();
  const scopes: LocalConfig[] = [];
  for (const config of [project, user]) {
    if (config === null || homes.has(getDataHome(config))) continue;
    homes.add(getDataHome(config));
    scopes.push(config);
  }
  return scopes;
}

/** The scopes `cwd` reaches whose finished attended sessions the background pass judges or publishes. */
export async function backgroundPassScopes(cwd?: string): Promise<LocalConfig[]> {
  const scopes: LocalConfig[] = [];
  for (const config of await reachedScopes(cwd)) {
    const { judges, publishes } = await attendedWork(config);
    if (judges || publishes) scopes.push(config);
  }
  return scopes;
}

/** The hidden command: the background pass over the scopes of this directory. */
export async function scoreSessionsCommand(): Promise<void> {
  await scoreSessions(await backgroundPassScopes());
}
