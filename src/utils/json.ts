import type { JsonValue } from '../types.js';

/**
 * A JSON document's value, as JSON.parse builds it: no copy, so a `__proto__` key stays the own key the file holds
 * and a file written back keeps it. A schema copy (`JsonValueSchema.parse`) drops it.
 */
export function parseJson(text: string): JsonValue {
  return JSON.parse(text);
}
