/**
 * CLI entry point for `teamai hook-dispatch <event> --tool <tool> [--matcher <m>]`.
 *
 * Reads STDIN once, creates the dispatcher with the full handler registry,
 * and dispatches to all matching handlers. Outputs any handler result to STDOUT.
 */

import { createDispatcher } from './hook-dispatch.js';
import { buildHandlerRegistry } from './hook-handlers.js';
import { log } from './utils/logger.js';

/** Read STDIN fully. Returns empty string if STDIN is a TTY. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Main CLI handler for hook-dispatch.
 */
export async function hookDispatchCli(event: string, tool: string, matcher: string): Promise<void> {
  // Read STDIN once — shared across all handlers
  const raw = await readStdin();
  let stdin: Record<string, unknown> = {};
  if (raw.trim()) {
    try {
      stdin = JSON.parse(raw);
    } catch {
      log.debug(`hook-dispatch: failed to parse STDIN JSON for event=${event}`);
      return;
    }
  }

  // Build dispatcher with full handler registry
  const registry = buildHandlerRegistry();
  const dispatcher = createDispatcher({ handlers: registry });

  // Dispatch
  const result = await dispatcher.dispatch(event, matcher, stdin, tool);

  // Log errors (to debug, not STDOUT — STDOUT is reserved for hook output)
  for (const err of result.errors) {
    log.debug(`hook-dispatch: handler "${err.handlerName}" failed: ${err.error.message}`);
  }

  // Write output to STDOUT if any handler produced one
  if (result.output) {
    process.stdout.write(result.output);
  }
}
