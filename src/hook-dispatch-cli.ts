/**
 * CLI entry point for `teamai hook-dispatch <event> --tool <tool> [--matcher <m>]`.
 * Reads STDIN once, fans out to all matching handlers, writes at most one
 * handler's output to STDOUT. STDOUT is reserved for the AI-tool hook JSON
 * payload; all log lines go to STDERR (see setStderrOnly below).
 */

import { createDispatcher } from './hook-dispatch.js';
import { buildHandlerRegistry } from './hook-handlers.js';
import { log, setStderrOnly } from './utils/logger.js';

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
  // Reserve STDOUT for the dispatcher's hook payload; log lines go to STDERR.
  setStderrOnly(true);

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

  // WorkBuddy/CodeBuddy may pass hook_event_name: "" — normalize to the
  // CLI-derived event name so downstream handlers (parseHookEvent, etc.)
  // can correctly determine the event type.
  if (!stdin.hook_event_name) {
    const EVENT_MAP: Record<string, string> = {
      'session-start': 'SessionStart',
      'stop': 'Stop',
      'post-tool-use': 'PostToolUse',
      'prompt-submit': 'UserPromptSubmit',
    };
    stdin.hook_event_name = EVENT_MAP[event] ?? event;
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
