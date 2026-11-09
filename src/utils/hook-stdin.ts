/**
 * A hook's stdin: read once, never blocking past a host that does not close
 * it, and handed from the hook fast path to the full dispatch when the fast
 * path falls through. It loads before the CLI bundle (hook-fast-path.ts), so
 * it imports nothing but Node.
 */

import type { Readable } from 'node:stream';

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

/** Leave the stdin the fast path read for the full dispatch it falls through to. */
export function handOffHookStdin(raw: string): void {
  globalThis.teamaiHandedOffHookStdin = raw;
}

/** The stdin the fast path read before it fell through, once; undefined when it read none. */
export function takeHandedOffHookStdin(): string | undefined {
  const raw = globalThis.teamaiHandedOffHookStdin;
  globalThis.teamaiHandedOffHookStdin = undefined;

  return raw;
}
