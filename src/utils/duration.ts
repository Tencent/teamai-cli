const DURATION = /^(\d+)(ms|s|m|h|d)$/;
const DURATION_UNITS = new Map([['ms', 1], ['s', 1000], ['m', 60_000], ['h', 3_600_000], ['d', 86_400_000]]);

/** A positive whole number of `ms`, `s`, `m`, `h`, or `d`, such as `30s` or `14d`, read as milliseconds; undefined otherwise. */
export function durationMs(text: string): number | undefined {
  const [, amount = '', unit = ''] = DURATION.exec(text.trim()) ?? [];
  const ms = Number(amount) * (DURATION_UNITS.get(unit) ?? 0);

  return ms > 0 && Number.isSafeInteger(ms) ? ms : undefined;
}
