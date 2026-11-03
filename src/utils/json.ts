import { isDeepStrictEqual } from 'node:util';
import { applyEdits, modify, parseTree, printParseErrorCode, type FormattingOptions, type Node, type ParseError } from 'jsonc-parser';
import JSON5 from 'json5';
import { z } from 'zod';
import { isJsonObject, JsonValueSchema, type JsonObject, type JsonValue } from '../types.js';

/**
 * A JSON document's value, as JSON.parse builds it: no copy, so a `__proto__` key stays the own key the file holds
 * and a file written back keeps it. A schema copy (`JsonValueSchema.parse`) drops it.
 */
export function parseJson(text: string): JsonValue {
  return JSON.parse(text);
}

/**
 * A document of a tool that takes JSON5, as that tool reads it: plain JSON
 * first, then JSON5 (comments, trailing commas, unquoted keys). OpenClaw's
 * `parseConfigJson5` does the same with the same `json5` package. For reads
 * only: writing the value back would drop the member's comments.
 */
export function parseJson5(text: string): JsonValue {
  try {
    return parseJson(text);
  } catch {
    return JSON5.parse(text);
  }
}

/**
 * How a tool parses one of its JSON config files: `json` strictly, `jsonc`
 * with comments and trailing commas (jsonc-parser with `allowTrailingComma`),
 * `json-comments` with comments but no trailing commas (comments stripped,
 * then JSON.parse).
 */
export type JsonSyntax = 'json' | 'jsonc' | 'json-comments';

/** What a "does not parse" diagnosis adds to name the syntax: nothing for strict JSON, the only syntax most tools take. */
export const JSON_SYNTAX_CLAUSE: Readonly<Record<JsonSyntax, string>> = {
  json: '',
  jsonc: ' as JSON with comments',
  'json-comments': ' as JSON with comments and no trailing commas',
};

/** `text` as the tool that takes `syntax` reads it. Throws, naming the offset, on text that does not parse that way. */
export function parseJsonAs(text: string, syntax: JsonSyntax): JsonValue {
  if (syntax === 'json') return parseJson(text);

  try {
    return parseJson(text);
  } catch {
    const errors: ParseError[] = [];
    const root = parseTree(text, errors, { allowTrailingComma: syntax === 'jsonc', disallowComments: false });
    const [first] = errors;

    if (first !== undefined || root === undefined) {
      throw new SyntaxError(`${first === undefined ? 'no value' : printParseErrorCode(first.error)} at offset ${first?.offset ?? 0}`);
    }

    return valueOfNode(root);
  }
}

/** A parsed node's value, built as JSON.parse builds one: a `__proto__` key stays an own key. */
function valueOfNode(node: Node): JsonValue {
  switch (node.type) {
    case 'object': {
      const object: JsonObject = {};

      for (const [key, value] of (node.children ?? []).map((property) => property.children ?? [])) {
        const name = z.string().safeParse(key?.value);

        if (!name.success || value === undefined) continue;
        Object.defineProperty(object, name.data, { value: valueOfNode(value), enumerable: true, writable: true, configurable: true });
      }

      return object;
    }

    case 'array':
      return (node.children ?? []).map(valueOfNode);
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
    case 'property':
      return JsonValueSchema.parse(node.value ?? null);
    default: {
      const unhandled: never = node.type;

      return unhandled;
    }
  }
}

/**
 * `original`, a JSON-with-comments document, edited so it holds `next`: an
 * object is edited key by key, an array or a scalar that changed is replaced
 * whole, and a key `next` drops is removed. Every comment stays, and so does
 * the text outside the lines an edit touches; jsonc-parser formats those lines
 * with the original's indentation and line endings.
 */
export function editJsonText(original: string, next: JsonValue): string {
  const formattingOptions = formattingOf(original);
  let text = original;

  const edit = (path: Array<string | number>, before: JsonValue | undefined, after: JsonValue | undefined): void => {
    if (isJsonObject(before) && isJsonObject(after)) {
      for (const key of Object.keys(before)) {
        if (!Object.hasOwn(after, key)) text = applyEdits(text, modify(text, [...path, key], undefined, { formattingOptions }));
      }

      for (const [key, value] of Object.entries(after)) edit([...path, key], Object.hasOwn(before, key) ? before[key] : undefined, value);

      return;
    }

    if (isDeepStrictEqual(before, after)) return;
    text = applyEdits(text, modify(text, path, after, { formattingOptions }));
  };

  edit([], parseJsonAs(original, 'jsonc'), next);

  return text;
}

/** The indentation and line ending `text` uses: its first indented line's, else two spaces; CRLF when it has one. */
function formattingOf(text: string): FormattingOptions {
  const indent = /^[ \t]+(?=\S)/m.exec(text)?.[0] ?? '  ';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';

  return indent.startsWith('\t') ? { insertSpaces: false, tabSize: 1, eol } : { insertSpaces: true, tabSize: indent.length, eol };
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
