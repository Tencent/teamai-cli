/** JSON with object keys sorted and undefined fields left out, so equal values give equal text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sorted(value));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  const record: Record<string, unknown> = { ...value };
  return Object.fromEntries(Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => [key, sorted(record[key])]));
}
