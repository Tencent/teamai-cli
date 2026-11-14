// ─── Waiting with a bound ───

/** What `promise` gave within `ms`, or that it had not by then; it may still settle later. */
export async function within<TValue>(promise: Promise<TValue>, ms: number): Promise<{ answered: true; value: TValue } | { answered: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ answered: false }>((resolve) => { timer = setTimeout(() => resolve({ answered: false }), ms); });

  try {
    return await Promise.race([promise.then((value) => ({ answered: true as const, value })), late]);
  } finally {
    clearTimeout(timer);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
