/**
 * The local judging a drain does: which tools it offers, and the lock its pass holds while it takes leases.
 */
import path from 'node:path';
import { scoresDir } from './scorers/attempts.js';
import { confinedToolLevels } from './tool-launch/confined.js';
import type { ConfinedLevel } from './tool-launch/confined-level.js';
import type { LocalConfig } from './types.js';

/**
 * What the local judge tools can offer, strictest first: those whose profile reaches `verified`, then every installed
 * tool at `best-effort`. A tool is never offered at a level it cannot reach, since its judge would refuse the lease.
 */
export async function localJudgeOffers(): Promise<Array<{ isolation: ConfinedLevel; tools: [string, ...string[]] }>> {
  const levels = await confinedToolLevels();
  const offers: Array<{ isolation: ConfinedLevel; tools: [string, ...string[]] }> = [];
  const [verified, ...moreVerified] = levels.filter((level) => level.isolation === 'verified').map((level) => level.tool);

  if (verified) offers.push({ isolation: 'verified', tools: [verified, ...moreVerified] });
  const [any, ...more] = levels.map((level) => level.tool);

  if (any) offers.push({ isolation: 'best-effort', tools: [any, ...more] });

  return offers;
}

/**
 * The lock a drain's judging of the entries of `config` here holds, so two drains never take leases as one driver.
 */
export const judgePassLock = (config: LocalConfig): string => path.join(scoresDir(config), 'score-sessions.lock');
