/**
 * `teamai score-sessions` (#1179): the local driver that judges this machine's finished sessions in the background,
 * started detached after a session start's pull. It takes session work only, through the same leases as any driver,
 * judges each with a local tool, and leaves the labels pending for the next pull to publish.
 */
import path from 'node:path';
import { detectProjectConfig, loadLocalConfig } from './config.js';
import { scoresDir } from './scorers/attempts.js';
import { scoringUnavailable } from './scorers/home.js';
import { judgeToolLevels } from './scorers/judge.js';
import type { Isolation } from './scorers/label.js';
import { scopeScoring } from './scorers/settings.js';
import { SessionWork } from './session-flow/session-work.js';
import { getDataHome, type LocalConfig } from './types.js';
import { acquireLock, releaseLock } from './update.js';
import { pathExists } from './utils/fs.js';
import { log } from './utils/logger.js';
import { readWorkspaceChildren } from './workspace-children.js';
import { localDriver } from './workflow/local-driver.js';
import { judgeLease, takeJudgeLease } from './workflow/scoring.js';

/** How long one run takes new work for; a judge it started then still finishes. */
const RUN_MAX_MS = 30 * 60 * 1000;

/**
 * What the local judge tools can offer, strictest first: those whose profile reaches `verified`, then every installed
 * tool at `best-effort`. A tool is never offered at a level it cannot reach, since its judge would refuse the lease.
 */
async function localJudgeOffers(): Promise<Array<{ isolation: Isolation; tools: [string, ...string[]] }>> {
  const levels = await judgeToolLevels();
  const offers: Array<{ isolation: Isolation; tools: [string, ...string[]] }> = [];
  const [verified, ...moreVerified] = levels.filter((level) => level.isolation === 'verified').map((level) => level.tool);
  if (verified) offers.push({ isolation: 'verified', tools: [verified, ...moreVerified] });
  const [any, ...more] = levels.map((level) => level.tool);
  if (any) offers.push({ isolation: 'best-effort', tools: [any, ...more] });
  return offers;
}

/**
 * Judges the finished sessions of each scope in `configs`, in order, until none is left, the day's limit is spent, or
 * 30 minutes passed since it started. A scope another run is scoring is left to it.
 */
export async function scoreSessions(configs: readonly LocalConfig[], { clock = () => new Date().toISOString() }: { clock?: () => string } = {}): Promise<void> {
  const deadline = Date.parse(clock()) + RUN_MAX_MS;
  const offers = await localJudgeOffers();
  for (const config of configs) {
    if (scoringUnavailable(config)) continue;
    const scoring = await scopeScoring(config);
    if (!scoring.ok || !scoring.sessions.enabled) continue;
    const lock = path.join(scoresDir(config), 'score-sessions.lock');
    if (!await acquireLock(lock)) continue;
    try {
      const driver = localDriver(SessionWork.leaseCwd(config));
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
 * The scopes `cwd` reaches that turn session scoring on: its project scope, with its workspace children, whose
 * namespaces set scoring too, then the user scope, each data home once. A directory that no longer exists reaches the
 * user scope only.
 */
export async function sessionScoringScopes(cwd?: string): Promise<LocalConfig[]> {
  const detected = cwd === undefined || await pathExists(cwd) ? await detectProjectConfig(cwd).catch(() => null) : null;
  const project = detected && await readWorkspaceChildren(detected);
  const user = await loadLocalConfig();
  const homes = new Set<string>();
  const scopes: LocalConfig[] = [];
  for (const config of [project, user]) {
    if (config === null || homes.has(getDataHome(config)) || scoringUnavailable(config)) continue;
    homes.add(getDataHome(config));
    const scoring = await scopeScoring(config);
    if (scoring.ok && scoring.sessions.enabled) scopes.push(config);
  }
  return scopes;
}

/** The hidden command: the scopes of this directory that score sessions. */
export async function scoreSessionsCommand(): Promise<void> {
  await scoreSessions(await sessionScoringScopes());
}
