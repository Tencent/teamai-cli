import { STOP_GRACE_MS } from '@teamai/shared/process-group';
import { ANSWER_WITHIN_MS } from '../runtimes/stdio.js';

/**
 * The longest a fleet member's stop of a step may take, from when it begins: the wait for a step runtime to confirm a
 * cancel (`ANSWER_WITHIN_MS`), and SIGKILL `STOP_GRACE_MS` after SIGTERM for a command it runs here. A stop that has
 * not ended by then is given up on the member's side: the member writes nothing more of the claim.
 */
export const FLEET_STOP_BUDGET_MS = ANSWER_WITHIN_MS + STOP_GRACE_MS;

/** The shortest progress interval: a member writes progress at most once a second. */
const MIN_BEAT_MS = 1_000;

/** The shortest `stale_after` a fleet pool takes: three progress intervals and a member's stop (`FLEET_STOP_BUDGET_MS`). */
export const MIN_STALE_AFTER_MS = 3 * MIN_BEAT_MS + FLEET_STOP_BUDGET_MS;

/**
 * How often a member writes progress, and how long it runs a step none of whose progress landed. Its owner gives the
 * claim up once it read no new write for `stale_after` on its own clock, which starts no earlier than that write
 * landed, and the member began its last write that landed at the record's `progressAt`, before it landed. With
 * `beatMs` a third of what `stale_after` holds past the stop budget:
 *
 *   progressAt + cutOffMs + beatMs + FLEET_STOP_BUDGET_MS = progressAt + staleAfterMs <= landed + staleAfterMs <= the owner's earliest give-up
 *
 * So the member begins to stop the step a full progress interval and a whole stop budget before its owner may give the
 * claim up and offer the step again, and it gives up a stop that has not ended within the budget. The next write,
 * begun one interval after `progressAt`, has a full interval to land before the cut-off. A pool refuses a `stale_after`
 * below `MIN_STALE_AFTER_MS`; a record that names one, offered by an older teamai, gets beats a second apart and the
 * cut-off two of them, so the slack before the owner's give-up shrinks.
 */
export function fleetBeats(staleAfterMs: number) {
  const beatMs = Math.max(MIN_BEAT_MS, Math.floor((staleAfterMs - FLEET_STOP_BUDGET_MS) / 3));

  return { beatMs, cutOffMs: Math.max(staleAfterMs - beatMs - FLEET_STOP_BUDGET_MS, 2 * beatMs) };
}

/**
 * When, on the clock of the owner that wrote a cancel at `cancelAt`, a step its guardian ends by kill (`killBounded`)
 * has ended though its member never answered the cancel. The cancel replaced the member's last progress, so that
 * progress landed before the owner read the record to write the cancel, and the member writes no progress over a
 * cancel: its guardian kills the step at the cut-off point that progress set, whatever the member does. For any
 * `stale_after` a pool takes:
 *
 *   progressAt + cutOffMs + FLEET_STOP_BUDGET_MS = progressAt + staleAfterMs - beatMs <= landed + staleAfterMs - beatMs < cancelAt + staleAfterMs + beatMs
 */
export function killBoundedCancelEnd({ cancelAt, staleAfterMs }: { cancelAt: number; staleAfterMs: number }): number {
  return cancelAt + staleAfterMs + fleetBeats(staleAfterMs).beatMs;
}
