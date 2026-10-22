import { log } from './logger.js';

/**
 * Warnings already shown in this run. A pull resolves the manifests and each
 * entry type several times (per scope, and again for hooks, MCP and models
 * after the scopes), so a warning about the team repo would otherwise repeat.
 */
const shown = new Set<string>();

/** Warn once per run; returns false when `message` was already shown. */
export function warnOnce(message: string): boolean {
  if (shown.has(message)) return false;
  shown.add(message);
  log.warn(message);
  return true;
}

/** Debug lines already written in this run: see debugOnce. */
const written = new Set<string>();

/**
 * Write a debug line once per run. For a line a loop over items repeats with
 * the same text, such as a tool being skipped for each skill: a pull wrote
 * one per skill for every tool not installed, each a synchronous append.
 */
export function debugOnce(message: string): void {
  if (written.has(message)) return;
  written.add(message);
  log.debug(message);
}

/** Start a run: `pull` calls this so each pull warns (and writes debugOnce lines) again, once. */
export function resetWarnOnce(): void {
  shown.clear();
  written.clear();
}
