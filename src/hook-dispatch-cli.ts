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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveCliEntry } from './builtin-hooks.js';
import { captureTail } from './utils/exec.js';
import { createDispatcher, type Dispatcher } from './hook-dispatch.js';
import { buildHandlerRegistry, filterHandlersForConfig } from './hook-handlers.js';
import { resolveHookCwd } from './utils/hook-cwd.js';
import { windowsPowerShell } from './utils/powershell.js';
import { log, setStderrOnly } from './utils/logger.js';
import { deriveSessionId } from './utils/session-id.js';
import { COPILOT_TOOL_ID } from './types.js';

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
 * Start the detached child that re-runs this same dispatch for background-only
 * handlers, feeding it the already-consumed STDIN. On Windows it goes through
 * the WMI escape first (see trySpawnDetachedViaWmi) and falls back to the plain
 * detached spawn; the returned promise settles the launch.
 */
async function spawnBackground(
  event: string,
  tool: string,
  matcher: string,
  raw: string,
  cwd?: string,
): Promise<void> {
  const args = [resolveCliEntry() ?? '', 'hook-dispatch', event, '--tool', tool, '--bg-only'];
  if (matcher && matcher !== '*') {
    args.push('--matcher', matcher);
  }
  if (await trySpawnDetachedViaWmi(process.execPath, args, { cwd, stdin: raw })) return;
  await spawnPlainDetached(process.execPath, args, raw, cwd);
}

/** Plain `detached: true` child, awaiting the STDIN flush before the caller may exit. */
async function spawnPlainDetached(
  command: string,
  args: string[],
  stdin: string,
  cwd?: string,
): Promise<void> {
  try {
    const child = spawn(command, args, {
      detached: true,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      ...(cwd ? { cwd } : {}),
    });
    child.on('error', () => {});
    await new Promise<void>((resolve) => {
      if (!child.stdin) return resolve();
      child.stdin.on('error', () => resolve());
      child.stdin.end(stdin, () => resolve());
    });
    child.unref();
  } catch {
    // Never let a spawn failure surface to the host — background work is best-effort.
  }
}

/**
 * Identity fields worth salvaging when STDIN JSON cannot be parsed. On Windows
 * the hidden VBS launcher decodes the UTF-8 payload through the ANSI codepage,
 * so a payload containing multi-byte text can break the JSON structure at the
 * first non-ASCII sequence — everything after it is lost, but the ASCII head
 * (session id, tool name, paths) is intact and regex-extractable. Salvaging
 * keeps a degraded dispatch linked to the right session and tool in the
 * dashboard instead of collapsing into an anonymous event. Snake_case and
 * camelCase variants are both listed because hosts differ here (ZCode sends
 * hookEventName, Claude sends hook_event_name).
 */
const SALVAGEABLE_STDIN_FIELDS = [
  'session_id',
  'sessionId',
  'transcript_path',
  'transcriptPath',
  'tool_name',
  'toolName',
  'tool_use_id',
  'toolUseId',
  'cwd',
] as const;

/** camelCase salvage hits are mirrored onto the snake_case names handlers read. */
const CANONICAL_FIELD_ALIASES: Record<string, string> = {
  sessionId: 'session_id',
  transcriptPath: 'transcript_path',
  toolName: 'tool_name',
  toolUseId: 'tool_use_id',
};

/** Extract intact identity fields from an unparsable STDIN body (best-effort). */
export function salvageStdinFields(raw: string): Record<string, string> {
  const salvaged: Record<string, string> = {};
  for (const field of SALVAGEABLE_STDIN_FIELDS) {
    const m = raw.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (!m) continue;
    try {
      salvaged[field] = JSON.parse(`"${m[1]}"`) as string;
    } catch {
      // A mangled escape inside this field's value — skip it; degraded
      // payloads are best-effort by definition.
    }
    // Handlers read the canonical snake_case names (session_id, tool_name,
    // ...) — alias camelCase hits so a salvage from a camelCase host (ZCode)
    // still feeds deriveSessionId and the dashboard.
    const alias = CANONICAL_FIELD_ALIASES[field];
    if (alias && salvaged[field] !== undefined && salvaged[alias] === undefined) {
      salvaged[alias] = salvaged[field];
    }
  }
  return salvaged;
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
 * startup + the provider round trip), overlapped with the foreground pass.
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
export async function trySpawnDetachedViaWmi(
  command: string,
  args: string[],
  options: { cwd?: string; stdin?: string; platform?: NodeJS.Platform } = {},
): Promise<boolean> {
  // The platform is injectable for the same reason resolveCliPath's is: CI runs
  // ubuntu and macos only, so a hardcoded check would leave this entire path —
  // quoting, script assembly, refusal handling — untested everywhere.
  const { cwd, stdin, platform = process.platform } = options;
  if (platform !== 'win32') return false;
  // No STDIN (a caller that only needs the escape, not a payload hand-off).
  let payloadFile: string | undefined;
  if (stdin !== undefined) {
    payloadFile = path.join(os.tmpdir(), `teamai-hook-${process.pid}-${Date.now()}.json`);
    try {
      fs.writeFileSync(payloadFile, stdin, 'utf8');
    } catch {
      return false;
    }
    args = [...args, '--stdin-file', payloadFile];
  }

  const commandLine = [command, ...args].map(quoteWindowsArg).join(' ');
  // The provider rejects an empty CurrentDirectory with ReturnValue 21, and a
  // hook payload need not carry one (a session-start event often has no cwd).
  // Falls back to the temp dir, which always exists — the child re-resolves its
  // own working directory from the same payload anyway.
  const workingDir = cwd && fs.existsSync(cwd) ? cwd : os.tmpdir();
  const dirArg = psLiteral(workingDir);

  // Two spellings of the same provider call. The type accelerator is the fast
  // one (~0.3s); the cmdlet form is the fallback for hosts whose PowerShell
  // policy or language mode rejects the accelerator itself.
  //
  // Both spellings need the same two facts: ShowWindow is uint16 on the class
  // (an int is accepted without complaint but never reaches the provider as a
  // value it acts on — the created console window comes back), and a provider
  // refusal exits 3 so the retry rule can tell it from a script that failed.
  const refusal = 'if ($r.ReturnValue -ne 0) { Write-Output ("ReturnValue=" + $r.ReturnValue); exit 3 }';
  const commandArg = psLiteral(commandLine);
  const attempt = (startup: string, create: string) =>
    [startup, '$s.ShowWindow = [uint16]0', create, refusal].join('; ');
  const attempts = [
    attempt(
      "$s = ([wmiclass]'Win32_ProcessStartup').CreateInstance()",
      `$r = ([wmiclass]'Win32_Process').Create(${commandArg}, ${dirArg}, $s)`,
    ),
    attempt(
      '$s = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }',
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${commandArg}; CurrentDirectory = ${dirArg}; ProcessStartupInformation = $s }`,
    ),
  ];

  let lastDetail = 'no attempt made';
  for (const script of attempts) {
    const { code, tail } = await runPowerShell(script);
    if (code === 0) return true;
    lastDetail = `exit ${code}${tail ? `: ${tail}` : ''}`;
    // Exit 3 is the provider refusing the call: the other spelling would be
    // refused the same way. Any other failure is the script's own — exactly
    // what the second spelling exists to work around.
    if (code === 3) break;
  }

  if (payloadFile) fs.rmSync(payloadFile, { force: true });
  // Loud on purpose: a silent fallback here is exactly how the bug this path
  // exists for looked in the field (work never ran, nothing was logged).
  log.debug(`hook-dispatch: WMI escape unavailable (${lastDetail}) with cwd=${workingDir} - falling back to the plain detached spawn`);
  return false;
}

/** Run one PowerShell attempt; `code` is its exit status, `tail` its last output. */
async function runPowerShell(script: string): Promise<{ code: number | null; tail: string }> {
  // NOT detached: measured, a detached helper gets a 0 ReturnValue from the
  // provider while the process it claims to have created never runs at all.
  // `windowsHide` (CREATE_NO_WINDOW) is what keeps this helper invisible.
  const ps = spawn(
    windowsPowerShell(),
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const readTail = captureTail(ps, TAIL_CHARS);
  return new Promise((resolve) => {
    ps.on('error', (e) => resolve({ code: null, tail: e.message }));
    // 'close', not 'exit': the last output chunks can arrive after the process
    // is gone, and this tail is what the log line reports.
    ps.on('close', (code) => resolve({ code, tail: readTail() }));
  });
}

/** Output kept from a failed attempt, for its log line. */
const TAIL_CHARS = 200;

/** Encode a value as a PowerShell single-quoted literal. */
function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Quote one CreateProcess argument, leaving plain paths and flags untouched. */
function quoteWindowsArg(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/**
 * Read the STDIN payload a parent could not pipe, and remove it. The Windows/WMI
 * spawn path has no STDIN pipe, so the parent hands the payload over as a temp
 * file.
 */
function readStdinFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    log.debug(`hook-dispatch: could not read STDIN file ${file}: ${(e as Error).message}`);
    return '';
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Parse STDIN JSON and normalize the event name for downstream handlers. */
export function parseStdin(raw: string, event: string): Record<string, unknown> {
  let stdin: Record<string, unknown> = {};
  if (raw.trim()) {
    try {
      stdin = JSON.parse(raw);
    } catch {
      // Degrade instead of short-circuiting: handlers that depend on stdin
      // fields (votes-sync, contribute-check) self-skip when transcript_path
      // is absent, while background handlers that don't read stdin
      // (version-check, etc.) still get to run. Hook payloads can contain
      // prompts, credentials, and tool arguments, so diagnostics record only
      // structural metadata and never any part of the raw body.
      log.debug(
        `hook-dispatch: failed to parse STDIN JSON for event=${event}` +
          ` (len=${raw.length})`,
      );
      stdin = salvageStdinFields(raw);
    }
  }

  // JSON.parse succeeds for non-object values (`null`, numbers, booleans,
  // strings, arrays) that are not valid hook payloads. Without this guard,
  // the next `stdin.hook_event_name` access/assign throws TypeError in ESM
  // strict mode, which the outer try/catch swallows and short-circuits the
  // whole dispatch — the exact failure the malformed-JSON path above was
  // meant to prevent. Degrade any non-plain-object to {}.
  if (!stdin || typeof stdin !== 'object' || Array.isArray(stdin)) {
    stdin = {};
  }

  // WorkBuddy/CodeBuddy may pass hook_event_name: "" — normalize to the
  // CLI-derived event name so downstream handlers (parseHookEvent, etc.)
  // can correctly determine the event type.
  if (!stdin.hook_event_name) {
    const EVENT_MAP: Record<string, string> = {
      'session-start': 'SessionStart',
      'session-end': 'SessionEnd',
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

/** Keep the detached Copilot fallback stable without persisting a workspace path. */
export function deriveDispatchSessionId(
  stdin: Record<string, unknown>,
  tool: string,
): string {
  return deriveSessionId(stdin, { includeCwd: tool.toLowerCase() !== COPILOT_TOOL_ID });
}

/**
 * Main CLI handler for hook-dispatch.
 *
 * @param options Internal-only switches, set by the detached child's own spawn
 *   or by its parent: `bgOnly` runs only background handlers and never spawns
 *   again (prevents recursion), `stdinFile` carries the payload the Windows
 *   spawn path cannot pipe.
 */
export async function hookDispatchCli(
  event: string,
  tool: string,
  matcher: string,
  options: { bgOnly?: boolean; stdinFile?: string } = {},
): Promise<void> {
  const { bgOnly = false, stdinFile } = options;
  setStderrOnly(true);
  try {
    const raw = stdinFile ? readStdinFile(stdinFile) : await readStdin();
    const stdin = parseStdin(raw, event);

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
    let settling: Promise<void> | undefined;
    if (dispatcher.hasBackground(event, matcher)) {
      // Preserve one fallback ID across the parent and detached child. Without
      // this, hosts that omit session_id produce different PID-based IDs and
      // the foreground and post-pull paths can claim the same hint twice.
      if (typeof stdin.session_id !== 'string' || !stdin.session_id) {
        stdin.session_id = deriveDispatchSessionId(stdin, tool);
      }
      settling = spawnBackground(event, tool, matcher, JSON.stringify(stdin), cwd);
    }

    const output = await runDispatch(dispatcher, event, matcher, stdin, tool, 'foreground');

    if (output) {
      await new Promise<void>((resolve) => process.stdout.write(output, () => resolve()));
    }

    // Started before the foreground pass, awaited after it: the Windows escape's
    // PowerShell startup overlaps that pass, and this process outlives the
    // launch — its exit is what takes the host's job object down.
    await settling;
  } catch (e) {
    log.warn(`hook-dispatch: unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
