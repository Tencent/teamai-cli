/** Checked by `tsc` only: Vitest runs `*.test.ts`. */
import { loadTeamConfig, loadTeamConfigIfPresent } from '../config.js';
import type { LocalConfig } from '../types.js';

declare const member: LocalConfig;

/** A load names the member whose tool instances it reads, or `null` for none. */
export const forMember = (): unknown => loadTeamConfig('/team', member);
export const forNoMember = (): unknown => loadTeamConfig('/team', null);
export const presentForMember = (): unknown => loadTeamConfigIfPresent('/team', member);
// @ts-expect-error a load that names no member would read only the team root's tool instances without saying so
export const unsaid = (): unknown => loadTeamConfig('/team');
// @ts-expect-error the same, through the loader that refuses a team config it cannot use
export const presentUnsaid = (): unknown => loadTeamConfigIfPresent('/team');
