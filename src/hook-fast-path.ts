/**
 * The hook fast path (#1788): a hook whose handlers all run in the detached
 * background child needs nothing of the CLI bundle in the process the agent
 * waits on. That process reads the payload, starts the same `--bg-only` child
 * the full dispatch would, and exits before `cli.js` loads.
 *
 * It runs in `index.js` (bin.ts), before the compile cache is on and outside
 * the CLI bundle, so it imports nothing but Node and dependency-free helpers
 * (lint rule `teamai/uncached-entry`). The facts it shares with the bundle are
 * copies, which hook-fast-path.test.ts checks against the code they mirror.
 *
 * Anything the fast path cannot answer for falls through to the full dispatch
 * in the same process, which reads no stdin again: the fast path hands over
 * what it read (utils/hook-stdin.ts).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { writeToFile } from './utils/debug-log.js';
import { handOffHookStdin, readStdin } from './utils/hook-stdin.js';
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
 * Tools whose hook the fast path never takes: those whose `hooks.needsBundle`
 * is true in TOOLS (src/tools.ts), which hook-fast-path.test.ts checks this
 * copy against, and git, which runs its handlers inline.
 */
const FULL_DISPATCH_TOOLS = new Set(['copilot', 'agy', 'git']);

/** The payload fields a session id may come in; without one, the full dispatch derives one the child must share. */
const SESSION_ID_FIELDS = ['session_id', 'sessionId', 'conversation_id'] as const;

/** The events the fast path may take: a tool call, and a prompt (#1788). */
const FAST_EVENTS = ['post-tool-use', 'prompt-submit'] as const;

/** A hook the fast path may take, as its argv names it. */
export interface FastHook {
  event: typeof FAST_EVENTS[number];
  tool: string;
  matcher: string;
}

/** What argv and the environment alone decide: skip the hook, run the full dispatch, or read the payload to decide. */
export type ArgvVerdict = { kind: 'skip' } | { kind: 'full' } | { kind: 'payload'; hook: FastHook };

/**
 * The verdict for `teamai <argv>` before any stdin is read. Only the exact
 * commands teamai installs, `hook-dispatch post-tool-use --tool <t> [--matcher
 * <m>]` and `hook-dispatch prompt-submit --tool <t>`, may take the fast path;
 * any other flag (`--team-hooks`, `--bg-only`, `--stdin-file`,
 * `--copilot-global`) is the full dispatch's.
 */
export function argvVerdict(argv: readonly string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ArgvVerdict {
  // A Windows child needs the WMI escape, which lives in the bundle.
  if (platform === 'win32') return { kind: 'full' };
  const [command, event, toolFlag, tool, matcherFlag, matcher, ...rest] = argv;

  const fastEvent = FAST_EVENTS.find((candidate) => candidate === event);

  if (command !== 'hook-dispatch' || !fastEvent || toolFlag !== '--tool' || !tool || rest.length > 0) return { kind: 'full' };

  if (matcherFlag !== undefined && (fastEvent !== 'post-tool-use' || matcherFlag !== '--matcher' || !matcher)) return { kind: 'full' };
  const launcher = env[LAUNCHED_BY_ENV];

  // A session teamai launched for itself runs no hooks (hookDispatchCli's first check).
  if (launcher && launcher !== 'workflow') return { kind: 'skip' };

  // `--matcher TodoWrite` is the entry an earlier release installed, until the next pull removes it.
  if (env[ATTEMPT_ENV] || FULL_DISPATCH_TOOLS.has(tool) || matcher === 'TodoWrite') return { kind: 'full' };

  // A Claude-format hook may belong to Cursor or Copilot CLI, which the full dispatch tells apart (claude-hook-host.ts).
  if (tool === 'claude' && (env.CURSOR_VERSION?.trim() || env.COPILOT_PROJECT_DIR?.trim())) return { kind: 'full' };

  return { kind: 'payload', hook: { event: fastEvent, tool, matcher: matcher ?? '*' } };
}

/**
 * The payload to hand the background child, and the session it names, or null
 * when the full dispatch must take it: a payload that is not a JSON object;
 * one with no session id, for which the foreground derives an id from its own
 * pid that the child could not reproduce; or a TodoWrite call, which the hint
 * answers in the foreground (hook-handlers.ts `todowrite-hint`). Keys only the
 * foreground may set are dropped.
 */
export function childPayload(raw: string): { payload: string; sessionId: string } | null {
  const fields = jsonObjectFields(raw);
  // The first field that holds an id, as utils/session-id.ts `deriveSessionId` reads them.
  const sessionId = fields && SESSION_ID_FIELDS.map((field) => fields.get(field)).find(isNonEmptyString);

  if (!fields || !sessionId || fields.get('tool_name') === 'TodoWrite') return null;

  if (!FOREGROUND_PAYLOAD_KEYS.some((key) => fields.has(key))) return { payload: raw, sessionId };

  for (const key of FOREGROUND_PAYLOAD_KEYS) fields.delete(key);

  return { payload: JSON.stringify(Object.fromEntries(fields)), sessionId };
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

/**
 * Whether a prompt of `sessionId` has something only its foreground prints:
 * a package hint the detached pull left (pkg-hint.ts), a contribute hint a
 * Stop could not print (contribute-check.ts `pendingHint`), or, on a machine
 * that syncs over HTTP, the local agent's notices. The hint files are named as
 * both modules name them. The contribute hint is looked for on every tool,
 * not only on those whose Stop output is ignored, which is the only place one
 * is written: one small read, and no copy of the tool table.
 */
export function promptAnswersInForeground(sessionId: string, env: NodeJS.ProcessEnv): boolean {
  const teamaiHome = path.join(getUserHome(), '.teamai');
  const file = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');

  return fs.existsSync(path.join(teamaiHome, 'package-hints', `${file}.pending.json`))
    || (readTextFile(path.join(teamaiHome, 'sessions', `${file}.json`)) ?? '').includes('"pendingHint"')
    || isHttpEnrolled(env);
}

/** A file's text, or null when it cannot be read. */
function readTextFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
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
  const { event, tool, matcher } = verdict.hook;
  const child = childPayload(raw);

  if (child === null || (event === 'prompt-submit' && promptAnswersInForeground(child.sessionId, options.env))) {
    handOffHookStdin(raw);

    return 'full';
  }

  await spawnBackgroundChild(process.execPath, [options.entry, 'hook-dispatch', event, '--tool', tool, '--bg-only', ...(matcher === '*' ? [] : ['--matcher', matcher])], child.payload);
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
