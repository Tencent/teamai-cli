// -*- coding: utf-8 -*-

/**
 * Parse an integer CLI option such as --port or --project-id.
 * Throws a readable error instead of letting NaN or a fractional value reach the caller.
 */
export function parseIntOption(name: string, value: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = /^\s*\d+\s*$/.test(value) ? Number(value) : NaN;

  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? `an integer >= ${min}` : `an integer between ${min} and ${max}`;
    throw new Error(`${name} must be ${range}`);
  }

  return parsed;
}
