import { z } from 'zod';

/** Any value JSON (or YAML read as JSON) can hold: what arbitrary parsed input is before a domain schema narrows it. */
export const JsonValueSchema = z.json();

export type JsonValue = z.infer<typeof JsonValueSchema>;

/** A JSON object: a document, or a mapping inside one. */
export type JsonObject = { [key: string]: JsonValue };

/** A JSON object, parsed: a copy that leaves out `__proto__` keys, so check a file that is written back without it. */
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema) satisfies z.ZodType<JsonObject>;

/** One line of a JSONL file, parsed: a JSON object. */
export type JsonlRecord = JsonObject;

/**
 * Whether `value` is an object as JSON and YAML parse one: a plain object, not an array, a Date, a Map, a function or a
 * class instance. Its values are taken as they stand, as callers build objects with fields left undefined, so input
 * that must hold JSON throughout is parsed with `JsonObjectSchema` instead.
 */
export function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || value === undefined || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

/**
 * A JSON document's value, as JSON.parse builds it: no copy, so a `__proto__` key stays the own key the file holds
 * and a file written back keeps it. A schema copy (`JsonValueSchema.parse`) drops it.
 */
export function parseJson(text: string): JsonValue {
  return JSON.parse(text);
}

/**
 * How a tool parses one of its JSON config files: `json` strictly, `jsonc`
 * with comments and trailing commas (jsonc-parser with `allowTrailingComma`),
 * `json-comments` with comments but no trailing commas (comments stripped,
 * then JSON.parse), `json5` as OpenClaw 2026.10.9's `parseConfigJson5` does:
 * JSON.parse, then the `json5` package (unquoted keys too). teamai edits a
 * `jsonc` or `json-comments` file keeping its comments (`editJsonText`), and
 * rewrites a `json5` one only while it is plain JSON.
 */
export type JsonSyntax = 'json' | 'jsonc' | 'json-comments' | 'json5';

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
