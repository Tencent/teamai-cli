// ─── Promise / timer helpers ───────────────────────────

/**
 * Race a promise against a timeout, and — crucially — clear the timeout timer
 * when the promise settles first.
 *
 * A plain `Promise.race([promise, timeoutPromise])` leaves the losing timer
 * pending on the Node event loop: when `promise` resolves quickly, the timeout
 * callback stays scheduled and keeps the process alive for the full `timeoutMs`
 * after all real work has finished. For a hook-driven CLI this is a frequent,
 * very visible hang — e.g. `teamai pull` auto-reporting usage pushes with a 5s
 * guard would sit idle at the terminal for ~5s on every successful push.
 *
 * Clearing the timer on the fast path lets the process exit as soon as its work
 * is done, while still rejecting promptly if `promise` exceeds `timeoutMs`.
 *
 * @returns the resolved value of `promise`
 * @throws  `Error(message)` if `timeoutMs` elapses before `promise` settles,
 *          or whatever `promise` rejects with otherwise.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
