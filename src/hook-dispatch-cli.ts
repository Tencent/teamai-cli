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

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDispatcher, type Dispatcher } from './hook-dispatch.js';
import { buildHandlerRegistry, filterHandlersForConfig } from './hook-handlers.js';
import { resolveHookCwd } from './utils/hook-cwd.js';
import { log, setStderrOnly } from './utils/logger.js';
import { deriveSessionId } from './utils/session-id.js';

/**
 * Max time to wait for STDIN EOF before proceeding with whatever was received.
 *
 * `for await (process.stdin)` only ends when the host closes the pipe (EOF). If
 * the host (e.g. CodeBuddy) writes the hook payload but never closes STDIN — or
 * opens the pipe without sending EOF — the read would hang until the host aborts
 * the hook with "Hook timed out after 10000ms" (error 3003), all *before* any
 * handler timeout can engage. Racing a short deadline lets us continue with the
 * payload we already buffered (a healthy host EOFs within milliseconds, so this
 * never triggers in normal use).
 */
const STDIN_READ_TIMEOUT_MS = 1_000;

/**
 * Read STDIN fully, but never block longer than STDIN_READ_TIMEOUT_MS waiting
 * for EOF. Returns empty string if STDIN is a TTY. On timeout, returns whatever
 * chunks were already received (typically the full payload minus a missing EOF).
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  const readAll = (async () => {
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
  })();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, STDIN_READ_TIMEOUT_MS);
    // Don't let this timer itself keep the event loop alive.
    timer.unref();
  });
  try {
    await Promise.race([readAll, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  // Swallow late read errors/rejections so an aborted read can't crash the hook.
  readAll.catch(() => {});
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Spawn a detached child that re-runs this same dispatch for background-only
 * handlers, feeding it the already-consumed STDIN. The child is detached and
 * unref'd so the parent (and thus the host's hook) can exit — even via the
 * caller's process.exit(0) — without waiting for or killing it; its
 * stdout/stderr are ignored so no open pipe keeps the parent alive.
 *
 * On Windows detaching alone does not free the child — it would still inherit
 * the hook's job object — so it is created through WMI first (see
 * trySpawnDetachedViaWmi) and only falls back to the plain spawn below.
 */
function spawnBackground(
  event: string,
  tool: string,
  matcher: string,
  raw: string,
  cwd?: string,
): void {
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
  if (process.platform === 'win32' && trySpawnDetachedViaWmi(process.execPath, args, cwd, raw)) return;
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      ...(cwd ? { cwd } : {}),
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

/**
 * Create a detached child through the WMI service instead of CreateProcess.
 *
 * Windows hosts (WorkBuddy/CodeBuddy) run hook commands inside a job object and
 * terminate that job the moment the hook's direct child exits, so a child of
 * ours — even a `detached: true` one, which only gets DETACHED_PROCESS and
 * CREATE_NEW_PROCESS_GROUP — dies with the hook. Leaving a job requires
 * CREATE_BREAKAWAY_FROM_JOB, which node never passes; a process created by the
 * WMI service is outside our job by construction. Costs ~0.3s (PowerShell
 * startup + the provider round trip), which the hook pays.
 *
 * Two details this depends on:
 *   - Win32_ProcessStartup.ShowWindow = 0 hides the new console AT CREATION.
 *     `-WindowStyle Hidden` only hides it once PowerShell has started (the
 *     window still flashes), and the provider rejects CREATE_NO_WINDOW with
 *     ReturnValue 21.
 *   - the creating PowerShell runs with `windowsHide` (CREATE_NO_WINDOW), so not
 *     even it flashes.
 *
 * WMI has no STDIN pipe, so `stdin` travels as a temp file named on the command
 * line (`--stdin-file`); the child reads and removes it (readStdinFile).
 *
 * @returns true when the child was created; false when WMI refused or failed —
 *   the caller then falls back to the plain detached spawn.
 */
export function trySpawnDetachedViaWmi(
  command: string,
  args: string[],
  cwd: string | undefined,
  stdin: string,
): boolean {
  const payloadFile = path.join(os.tmpdir(), `teamai-hook-${process.pid}-${Date.now()}.json`);
  try {
    fs.writeFileSync(payloadFile, stdin, 'utf8');
  } catch {
    return false;
  }

  const argv = [...args, '--stdin-file', payloadFile];
  const commandLine = [command, ...argv].map(quoteWindowsArg).join(' ');
  const script = [
    "$s = ([wmiclass]'Win32_ProcessStartup').CreateInstance()",
    '$s.ShowWindow = 0',
    `$r = ([wmiclass]'Win32_Process').Create(${psLiteral(commandLine)}, ${psLiteral(cwd ?? '')}, $s)`,
    'if ($r.ReturnValue -ne 0) { exit 1 }',
  ].join('; ');

  let status: number | null = null;
  try {
    status = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: 'ignore' },
    ).status;
  } catch {
    status = null;
  }

  if (status === 0) return true;
  try {
    fs.unlinkSync(payloadFile);
  } catch {
    // the temp file is inert without the child that reads it
  }
  return false;
}

/** Encode a value as a PowerShell single-quoted literal. */
function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Quote one CreateProcess argument, leaving plain paths and flags untouched. */
function quoteWindowsArg(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/**
 * Read the STDIN payload a parent could not pipe. The Windows/WMI spawn path has
 * no STDIN pipe, so the parent hands the payload over as a temp file; it is
 * removed here, on every path.
 */
function readStdinFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    log.debug(`hook-dispatch: could not read STDIN file ${file}: ${(e as Error).message}`);
    return '';
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      // a stale temp file is inert
    }
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
  const cwd = resolveHookCwd(stdin);
  if (cwd) stdin.cwd = cwd;
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
 * @param stdinFile Payload file used instead of the STDIN pipe on the Windows
 *   spawn path, where the creating service cannot hand one over.
 */
export async function hookDispatchCli(
  event: string,
  tool: string,
  matcher: string,
  bgOnly = false,
  stdinFile?: string,
): Promise<void> {
  setStderrOnly(true);
  try {
    const raw = stdinFile ? readStdinFile(stdinFile) : await readStdin();
    const stdin = parseStdin(raw, event);
    if (stdin === null) return;

    // Provider-config gate: HTTP-only teams must not receive git-provider-only
    // hook prompts (contribute / mr-hint / votes). Prefer the project-scope
    // config when the host tells us the working directory (#264), so
    // filterHandlersForConfig can honour a project-level repo.kind.
    const { loadLocalConfig, detectProjectConfig } = await import('./config.js');
    const cwd = resolveHookCwd(stdin);
    if (cwd) {
      try {
        process.chdir(cwd);
      } catch (e) {
        log.debug(`hook-dispatch: chdir to ${cwd} failed: ${(e as Error).message}`);
      }
    }
    const localConfig = (cwd ? await detectProjectConfig(cwd) : null) ?? await loadLocalConfig();
    const handlers = filterHandlersForConfig(buildHandlerRegistry(), localConfig);
    const dispatcher = createDispatcher({ handlers });

    // Detached child: run the fire-and-forget handlers, then exit. No output is
    // wired back to the host (the parent already returned).
    if (bgOnly) {
      await runDispatch(dispatcher, event, matcher, stdin, tool, 'background');
      return;
    }

    // Parent: kick off background handlers in a detached process first so they
    // start working while we run the inline (foreground) pass.
    if (dispatcher.hasBackground(event, matcher)) {
      // Preserve one fallback ID across the parent and detached child. Without
      // this, hosts that omit session_id produce different PID-based IDs and
      // the foreground and post-pull paths can claim the same hint twice.
      if (typeof stdin.session_id !== 'string' || !stdin.session_id) {
        stdin.session_id = deriveSessionId(stdin, { includeCwd: true });
      }
      spawnBackground(event, tool, matcher, JSON.stringify(stdin), cwd);
    }

    const output = await runDispatch(dispatcher, event, matcher, stdin, tool, 'foreground');

    if (output) {
      await new Promise<void>((resolve) => process.stdout.write(output, () => resolve()));
    }
  } catch (e) {
    log.warn(`hook-dispatch: unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
