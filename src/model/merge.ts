export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** An array whose every element is an object carrying a string `id`. */
function isIdArray(value: unknown): value is Array<Record<string, unknown> & { id: string }> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => isPlainObject(item) && typeof item.id === 'string')
  );
}

/** Upsert patch entries into base by `id`: existing ids are replaced in place, new ids appended. */
export function upsertById(
  base: Array<Record<string, unknown> & { id: string }>,
  patch: Array<Record<string, unknown> & { id: string }>,
): Array<Record<string, unknown> & { id: string }> {
  const merged = [...base];
  const index = new Map(merged.map((item, i) => [item.id, i]));
  for (const item of patch) {
    const at = index.get(item.id);
    if (at === undefined) {
      index.set(item.id, merged.length);
      merged.push(item);
    } else {
      merged[at] = item;
    }
  }
  return merged;
}

/** Append patch entries not already present (by JSON value), preserving base order. */
function appendUnique(base: unknown[], patch: unknown[]): unknown[] {
  const merged = [...base];
  const seen = new Set(merged.map((item) => JSON.stringify(item)));
  for (const item of patch) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

/**
 * Recursively merge a rendered config fragment into an existing config:
 *   - objects merge recursively (new keys added, existing keys kept);
 *   - arrays of objects with string `id`s are upserted by id (model lists);
 *   - other arrays append, de-duplicated by value;
 *   - scalars are overwritten by the fragment.
 *
 * Inputs are never mutated.
 */
export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      result[key] = deepMerge(current, value);
    } else if (isIdArray(value) && isIdArray(current)) {
      result[key] = upsertById(current, value);
    } else if (Array.isArray(value) && Array.isArray(current)) {
      result[key] = appendUnique(current, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
