/**
 * The level a confined run reaches and what its tool can do there, as offers, leases and labels name them. It imports
 * nothing, so the workflow's `can` schema reads it without loading the scorers.
 */

/** `verified`: the tool's confined profile is known to keep it to its directory on this machine. */
export const CONFINED_LEVELS = ['best-effort', 'verified'] as const;

export type ConfinedLevel = (typeof CONFINED_LEVELS)[number];

/** What a tool run confined can do beyond answering: nothing, read its directory, or whatever its tool allows. */
export const ACCESS_LEVELS = ['answer', 'read', 'full'] as const;

export type ConfinedAccess = (typeof ACCESS_LEVELS)[number];
