/**
 * The hook fast path (#1788): a hook whose handlers all run in the detached
 * background child needs nothing of the CLI bundle in the process the agent
 * waits on. That process reads the payload, starts the same `--bg-only` child
 * the full dispatch would, and exits before `cli.js` loads.
 *
 * It runs in `index.js` (bin.ts), before the compile cache is on and outside
 * the CLI bundle, so it imports nothing but Node and dependency-free helpers.
 * The few facts it shares with the bundle are copies, which
 * hook-fast-path.test.ts keeps equal to the code they mirror.
 *
 * Anything the fast path cannot answer for falls through to today's full
 * dispatch, which is never slower than before: the stdin it already read is
 * handed over in-process (`takeHandedOffHookStdin`).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { writeToFile } from './utils/debug-log.js';
import { getUserHome } from './utils/home.js';

/** launch-context.ts `LAUNCHED_BY_ENV`. */
// oxlint-disable-next-line teamai/launch-env -- a copy: launch-context.ts loads zod, which this module runs before; hook-fast-path.test.ts keeps it equal
export const LAUNCHED_BY_ENV = 'TEAMAI_LAUNCHED_BY';

/** launch-context.ts `ATTEMPT_ENV`: a step's hooks use its clone's install home. */
// oxlint-disable-next-line teamai/launch-env -- a copy, as LAUNCHED_BY_ENV is
export const ATTEMPT_ENV = 'TEAMAI_WORKFLOW_ATTEMPT';

/**
 * The payload keys only the foreground dispatcher may set (launch-context.ts
 * `SESSION_RUN_PAYLOAD_KEY` and `LAUNCH_PAYLOAD_KEY`). The fast path forwards
 * neither, so the background child reads both from the environment it
 * inherited from the session (#1176).
 */
export const FOREGROUND_PAYLOAD_KEYS = ['teamai_run', 'teamai_launch'] as const;

/** The variables local-agent.ts `loadLocalAgentConfig` takes an HTTP endpoint from when nothing is stored. */
export const HTTP_ENDPOINT_ENVS = ['TEAMAI_HTTP_ENDPOINT', 'TEAMAI_ENDPOINT', 'TEAMAI_API_BASE_URL'] as const;

/**
 * Tools whose hook the fast path never takes: Copilot and Antigravity CLI
 * translate their payload in the bundle, and git runs its handlers inline.
 */
const FULL_DISPATCH_TOOLS = new Set(['copilot', 'agy', 'git']);

/** The payload fields a session id may come in; without one, the full dispatch derives one the child must share. */
const SESSION_ID_FIELDS = ['session_id', 'sessionId', 'conversation_id'] as const;

/** A hook the fast path may take, as its argv names it. */
export interface FastHook {
  event: 'post-tool-use';
  tool: string;
  matcher: string;
}

/** What argv and the environment alone decide: skip the hook, run the full dispatch, or read the payload to decide. */
export type ArgvVerdict = { kind: 'skip' } | { kind: 'full' } | { kind: 'payload'; hook: FastHook };

/**
 * The verdict for `teamai <argv>` before any stdin is read. Only the exact
 * command teamai installs, `hook-dispatch post-tool-use --tool <t> [--matcher
 * <m>]`, may take the fast path; any other flag (`--team-hooks`, `--bg-only`,
 * `--stdin-file`, `--copilot-global`) is the full dispatch's.
 */
export function argvVerdict(argv: readonly string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ArgvVerdict {
  // A Windows child needs the WMI escape, which lives in the bundle.
  if (platform === 'win32') return { kind: 'full' };
  const [command, event, toolFlag, tool, matcherFlag, matcher, ...rest] = argv;

  if (command !== 'hook-dispatch' || event !== 'post-tool-use' || toolFlag !== '--tool' || !tool || rest.length > 0) return { kind: 'full' };

  if (matcherFlag !== undefined && (matcherFlag !== '--matcher' || !matcher)) return { kind: 'full' };
  const launcher = env[LAUNCHED_BY_ENV];

  // A session teamai launched for itself runs no hooks (hookDispatchCli's first check).
  if (launcher && launcher !== 'workflow') return { kind: 'skip' };

  if (env[ATTEMPT_ENV] || FULL_DISPATCH_TOOLS.has(tool) || matcher === 'TodoWrite') return { kind: 'full' };

  // A Claude-format hook may belong to Cursor or Copilot CLI, which the full dispatch tells apart (claude-hook-host.ts).
  if (tool === 'claude' && (env.CURSOR_VERSION?.trim() || env.COPILOT_PROJECT_DIR?.trim())) return { kind: 'full' };

  return { kind: 'payload', hook: { event, tool, matcher: matcher ?? '*' } };
}

/**
 * The payload to hand the background child, or null when the full dispatch
 * must take it: a payload that is not a JSON object, or one with no session
 * id, for which the foreground derives an id from its own pid that the child
 * could not reproduce. Keys only the foreground may set are dropped.
 */
export function childPayload(raw: string): string | null {
  const fields = jsonObjectFields(raw);

  if (!fields || !SESSION_ID_FIELDS.some((field) => isNonEmptyString(fields.get(field)))) return null;

  if (!FOREGROUND_PAYLOAD_KEYS.some((key) => fields.has(key))) return raw;

  for (const key of FOREGROUND_PAYLOAD_KEYS) fields.delete(key);

  return JSON.stringify(Object.fromEntries(fields));
}

/** The fields of the JSON object `raw` holds, or null for anything else. Parsed by hand: zod loads with the bundle. */
function jsonObjectFields(raw: string): Map<string, unknown> | null {
  let payload: unknown;

  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }

  return payload instanceof Object && !Array.isArray(payload) ? new Map(Object.entries(payload)) : null;
}

function isNonEmptyString(value: unknown): value is string {
  // oxlint-disable-next-line teamai/no-runtime-typeof -- the payload boundary itself, which this module parses by hand (jsonObjectFields)
  return typeof value === 'string' && value !== '';
}

/**
 * Whether this machine syncs with an HTTP source, so the local agent's handler
 * runs even where no teamai scope applies. A superset of local-agent.ts
 * `loadLocalAgentConfig` returning a config, read without loading it:
 * `local-agent/config.json` unless it says `"disabled": true` (a removed
 * source, which nothing reconnects), a member config with an HTTP repo
 * (a v0.17 enrolment), or an endpoint variable. hook-fast-path.test.ts checks
 * it against the loader.
 */
export function isHttpEnrolled(env: NodeJS.ProcessEnv): boolean {
  const teamaiHome = path.join(getUserHome(), '.teamai');
  const stored = readTextFile(path.join(teamaiHome, 'local-agent', 'config.json'));

  if (stored !== null) return jsonObjectFields(stored)?.get('disabled') !== true;
  const memberConfig = readTextFile(path.join(teamaiHome, 'config.yaml')) ?? '';

  return /\bkind:\s*['"]?http\b/.test(memberConfig) || HTTP_ENDPOINT_ENVS.some((name) => !!env[name]);
}

/** A file's text, or null when it cannot be read. */
function readTextFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

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
export async function readStdin(
  stream: Readable & { readonly isTTY?: boolean } = process.stdin,
  timeoutMs = STDIN_READ_TIMEOUT_MS,
): Promise<string> {
  if (stream.isTTY) return '';
  const chunks: Buffer[] = [];

  const readAll = (async () => {
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
  })();

  // The timeout path destroys the stream below. Attach a handler now so a late
  // iterator rejection cannot become an unhandled rejection after the race.
  void readAll.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;

  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
    // Don't let this timer itself keep the event loop alive.
    timer.unref();
  });

  try {
    await Promise.race([readAll, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  // A pending async iterator keeps the pipe handle alive even after the hook
  // has continued. Closing it releases the process when the host never sends EOF.
  if (timedOut && !stream.destroyed) stream.destroy();

  return Buffer.concat(chunks).toString('utf-8');
}

declare global {
  /**
   * The stdin the fast path read before it fell through to the full dispatch
   * in the same process. A module variable would not do: `index.js` and
   * `cli.js` are separate bundles, each with its own copy of this module.
   */
  var teamaiHandedOffHookStdin: string | undefined;
}

/** The stdin the fast path read before it fell through, once; undefined when it read none. */
export function takeHandedOffHookStdin(): string | undefined {
  const raw = globalThis.teamaiHandedOffHookStdin;
  globalThis.teamaiHandedOffHookStdin = undefined;

  return raw;
}

/** What the caller does next: exit (the hook is done or skipped), or load the CLI for the full dispatch. */
export type FastPathOutcome = 'done' | 'full';

/**
 * Take the fast path for `teamai <argv>` when it can, or say the full dispatch
 * must run. `entry` is the CLI script the background child runs; `stdin` is
 * only opened for a hook, so no other command touches it.
 */
export async function runHookFastPath(
  argv: readonly string[],
  options: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; stdin: () => Readable; entry: string },
): Promise<FastPathOutcome> {
  const verdict = argvVerdict(argv, options.env, options.platform);

  if (verdict.kind !== 'payload') return verdict.kind === 'skip' ? 'done' : 'full';
  const raw = await readStdin(options.stdin());
  const payload = childPayload(raw);

  if (payload === null) {
    globalThis.teamaiHandedOffHookStdin = raw;

    return 'full';
  }

  const { event, tool, matcher } = verdict.hook;
  await spawnBackgroundChild(process.execPath, [options.entry, 'hook-dispatch', event, '--tool', tool, '--bg-only', ...(matcher === '*' ? [] : ['--matcher', matcher])], payload);
  writeToFile('DEBUG', `[hook-dispatch] ${event}/${tool} fast path`);

  return 'done';
}

/** The detached child, in its own process group, once its stdin is flushed: the hook then exits without waiting for it. */
async function spawnBackgroundChild(command: string, args: string[], stdin: string): Promise<void> {
  try {
    const child = spawn(command, args, { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });

    child.on('error', () => {});
    await new Promise<void>((resolve) => {
      child.stdin.on('error', () => resolve());
      child.stdin.end(stdin, () => resolve());
    });
    child.unref();
  } catch {
    // Background work is best-effort, as for the full dispatch's spawn.
  }
}
