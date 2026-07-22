/**
 * CLI entry point for `teamai hook-dispatch <event> --tool <tool> [--matcher <m>]`.
 * Reads STDIN once, fans out to all matching handlers, writes at most one
 * handler's output to STDOUT. STDOUT is reserved for the AI-tool hook JSON
 * payload; all log lines go to STDERR (see setStderrOnly below).
 *
 * Foreground vs background:
 *   Handlers that may return output the host injects back into the session run
 *   inline (foreground). Pure side-effect handlers (version check, dashboard,
 *   local-agent) are marked `background` and run in a detached child process so
 *   a slow registry/network call cannot delay the host's hook completion —
 *   critical for CodeBuddy's 10s hook timeout. Detaching also survives the
 *   caller's process.exit(0) (index.ts), which otherwise kills in-process
 *   fire-and-forget work before it finishes.
 */

import { spawn } from 'node:child_process';

import { createDispatcher, type Dispatcher } from './hook-dispatch.js';
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
 * Spawn a detached child that re-runs this same dispatch for background-only
 * handlers, feeding it the already-consumed STDIN. The child is unref'd and
 * detached so the parent (and thus the host's hook) can exit — even via the
 * caller's process.exit(0) — without waiting for or killing it; its
 * stdout/stderr are ignored so no open pipe keeps the parent alive.
 */
function spawnBackground(event: string, tool: string, matcher: string, raw: string): void {
  try {
    const args = [
      process.argv[1],
      'hook-dispatch',
      event,
      '--tool',
      tool,
      '--bg-only',
    ];
    if (matcher && matcher !== '*') {
      args.push('--matcher', matcher);
    }
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', () => {});
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(raw);
    }
    child.unref();
  } catch {
    // Never let a spawn failure surface to the host — background work is best-effort.
  }
}

/** Parse STDIN JSON and normalize the event name for downstream handlers. */
function parseStdin(raw: string, event: string): Record<string, unknown> | null {
  let stdin: Record<string, unknown> = {};
  if (raw.trim()) {
    try {
      stdin = JSON.parse(raw);
    } catch {
      log.debug(`hook-dispatch: failed to parse STDIN JSON for event=${event}`);
      return null;
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
  return stdin;
}

/** Run one dispatch pass and log any handler errors (never to STDOUT). */
async function runDispatch(
  dispatcher: Dispatcher,
  event: string,
  matcher: string,
  stdin: Record<string, unknown>,
  tool: string,
  mode: 'foreground' | 'background',
): Promise<string | null> {
  const result = await dispatcher.dispatch(event, matcher, stdin, tool, mode);
  for (const err of result.errors) {
    log.debug(`hook-dispatch: handler "${err.handlerName}" failed: ${err.error.message}`);
  }
  return result.output;
}

/**
 * Main CLI handler for hook-dispatch.
 *
 * @param bgOnly When true, this is the detached child: run only background
 *   handlers and never spawn again (prevents recursion).
 */
export async function hookDispatchCli(
  event: string,
  tool: string,
  matcher: string,
  bgOnly = false,
): Promise<void> {
  // Reserve STDOUT for the dispatcher's hook payload; log lines go to STDERR.
  setStderrOnly(true);

  const raw = await readStdin();
  const stdin = parseStdin(raw, event);
  if (stdin === null) return;

  const dispatcher = createDispatcher({ handlers: buildHandlerRegistry() });

  // Detached child: run the fire-and-forget handlers, then exit. No output is
  // wired back to the host (the parent already returned).
  if (bgOnly) {
    await runDispatch(dispatcher, event, matcher, stdin, tool, 'background');
    return;
  }

  // Parent: kick off background handlers in a detached process first so they
  // start working while we run the inline (foreground) pass.
  if (dispatcher.hasBackground(event, matcher)) {
    spawnBackground(event, tool, matcher, raw);
  }

  const output = await runDispatch(dispatcher, event, matcher, stdin, tool, 'foreground');

  // Write output to STDOUT if any handler produced one, flushing before return
  // so the caller's process.exit(0) cannot truncate it.
  if (output) {
    await new Promise<void>((resolve) => process.stdout.write(output, () => resolve()));
  }
}
