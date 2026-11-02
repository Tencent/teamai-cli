/** JSON with object keys sorted and undefined fields left out, so equal values give equal text. */
// oxlint-disable-next-line teamai/no-unknown-parameters -- it serializes any value, as JSON.stringify does; callers hash records of many types
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sorted(value));
}

// oxlint-disable-next-line teamai/no-unknown-parameters, teamai/no-unknown-returns -- walks any value; narrowing it would change persisted hashes (a Date spreads to {})
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);

  // oxlint-disable-next-line teamai/no-runtime-typeof -- the walk itself: only objects are copied with sorted keys
  if (!value || typeof value !== 'object') return value;
  // oxlint-disable-next-line teamai/no-unsafe-dictionary-type, teamai/no-known-value-widening -- the copy of an object of any type, to read its keys
  const record: Record<string, unknown> = { ...value };

  return Object.fromEntries(Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => [key, sorted(record[key])]));
}
