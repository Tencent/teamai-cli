// ─── Deadlines ───────────────────────────────────────────
//
//  What a stop, a close and a sweep wait within: each answers by its deadline, while what it waits for goes on.
//

/**
 * How long a stop, or a whole close, may take before it is answered unconfirmed (#1717: "A runtime confirms a stop, or
 * a whole `close` (removal included, its stops confirmed in parallel), within 10 s"), inside teamai's own 15 s.
 */
export const BOUND_MS = 10_000;

/** What `work` settled with, or `late` once `deadline` (a Date.now() time) came first. `work` goes on either way. */
export async function by<T>(deadline: number, work: Promise<T>): Promise<{ kind: 'done'; value: T } | { kind: 'late' }> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<{ kind: 'late' }>((resolve) => { timer = setTimeout(() => resolve({ kind: 'late' }), Math.max(0, deadline - Date.now())); });

  try {
    return await Promise.race([work.then((value) => ({ kind: 'done' as const, value })), late]);
  } finally {
    clearTimeout(timer);
  }
}
