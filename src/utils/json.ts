import { z } from 'zod';
import { isJsonObject, type JsonValue } from '../types.js';

/**
 * A JSON document's value, as JSON.parse builds it: no copy, so a `__proto__` key stays the own key the file holds
 * and a file written back keeps it. A schema copy (`JsonValueSchema.parse`) drops it.
 */
export function parseJson(text: string): JsonValue {
  return JSON.parse(text);
}

/** `value` with each string in it, at any depth, replaced by `rewrite`'s result; keys and every other value stay. */
export function mapStrings(value: JsonValue, rewrite: (text: string) => string): JsonValue {
  const text = z.string().safeParse(value);

  return text.success ? rewrite(text.data)
    : Array.isArray(value) ? value.map((item) => mapStrings(item, rewrite))
      : isJsonObject(value) ? Object.fromEntries(Object.entries(value).map(([key, field]) => [key, mapStrings(field, rewrite)]))
        : value;
}

/** A list whose malformed elements are skipped, so one bad entry does not cost the others. */
export function lenientList<T>(element: z.ZodType<T>) {
  return z.array(element.nullable().catch(null)).transform((list) => list.flatMap((entry) => (entry === null ? [] : [entry])));
}
