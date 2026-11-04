import { isDeepStrictEqual } from 'node:util';
import { applyEdits, createScanner, findNodeAtLocation, modify, parseTree, printParseErrorCode, type FormattingOptions, type JSONPath, type Node, type ParseError, SyntaxKind } from 'jsonc-parser';
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

/** Whether `text` is blank or plain JSON, which teamai writes back as JSON.stringify writes it: no comment to keep. */
export function isPlainJson(text: string): boolean {
  if (text.trim() === '') return true;

  try {
    parseJson(text);

    return true;
  } catch {
    return false;
  }
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

/** `text` as the tool that takes `syntax` reads it. Throws, naming the offset, on text that does not parse that way. */
export function parseJsonAs(text: string, syntax: JsonSyntax): JsonValue {
  if (syntax === 'json') return parseJson(text);

  try {
    return parseJson(text);
  } catch {
    if (syntax === 'json5') return JSON5.parse(text);
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
    case 'property':
      return node.children?.[1] === undefined ? null : valueOfNode(node.children[1]);
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
      return JsonValueSchema.parse(node.value ?? null);
    default: {
      const unhandled: never = node.type;

      return unhandled;
    }
  }
}

/**
 * `original`, a JSON-with-comments document, edited so it holds `next`, with
 * every byte of the member's text outside the edits kept. Objects are edited
 * key by key and arrays element by element: a new key or a last element goes
 * on its own line after the last one there, so no sibling is reformatted or
 * loses the comment after it. A removed key or element takes its own text,
 * its comma and the comment on its line, and never a trailing comma the tool
 * may refuse. teamai writes no comment, so every comment above it is the
 * member's and stays. A scalar that changed is replaced in place.
 */
export function editJsonText(original: string, next: JsonValue): string {
  const formattingOptions = formattingOf(original);
  let text = original;

  const edit = (path: JSONPath, before: JsonValue | undefined, after: JsonValue | undefined): void => {
    if (isJsonObject(before) && isJsonObject(after)) {
      for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) text = withoutNode(text, [...path, key]);

      for (const [key, value] of Object.entries(after)) {
        if (Object.hasOwn(before, key)) edit([...path, key], before[key], value);
        else text = withAppended(text, path, key, value, formattingOptions) ?? applyEdits(text, modify(text, [...path, key], value, { formattingOptions }));
      }

      return;
    }

    if (Array.isArray(before) && Array.isArray(after)) {
      const kept = keptElements(before, after);
      const changed = changedElements(before.length, after.length, kept);

      for (const [from, to] of changed) edit([...path, from], before[from], after[to]);

      for (let index = before.length - 1; index >= 0; index--) if (!kept.has(index) && !changed.has(index)) text = withoutNode(text, [...path, index]);
      const matched = new Set([...kept.values(), ...changed.values()]);

      after.forEach((value, index) => {
        if (matched.has(index)) return;
        // After every element that stays, it is appended; before one, `modify` inserts it without touching that one.
        const appended = [...matched].every((at) => at < index) ? withAppended(text, path, null, value, formattingOptions) : null;

        text = appended ?? applyEdits(text, modify(text, [...path, index], value, { formattingOptions, isArrayInsertion: true }));
      });

      return;
    }

    if (isDeepStrictEqual(before, after)) return;
    text = applyEdits(text, modify(text, path, after, { formattingOptions }));
  };

  edit([], parseJsonAs(original, 'jsonc'), next);

  return text;
}

/** Each element of `before` that stays, by its index, paired in order with the index of its equal in `after`. */
function keptElements(before: readonly JsonValue[], after: readonly JsonValue[]): Map<number, number> {
  const kept = new Map<number, number>();
  let from = 0;

  after.forEach((value, index) => {
    const found = before.findIndex((element, at) => at >= from && isDeepStrictEqual(element, value));

    if (found === -1) return;
    kept.set(found, index);
    from = found + 1;
  });

  return kept;
}

/**
 * Each element of `before` that changed in place, by its index, paired with
 * the element at the same place in `after` between the same kept neighbours,
 * so an edit inside it keeps the comments it holds.
 */
function changedElements(beforeLength: number, afterLength: number, kept: ReadonlyMap<number, number>): Map<number, number> {
  const changed = new Map<number, number>();
  const anchors: Array<[number, number]> = [...kept, [beforeLength, afterLength]];
  let from = 0;
  let to = 0;

  for (const [keptFrom, keptTo] of anchors) {
    for (; from < keptFrom && to < keptTo; from++, to++) changed.set(from, to);
    from = keptFrom + 1;
    to = keptTo + 1;
  }

  return changed;
}

/** A comment that ends on its line, after optional blanks: `// …` or a one-line `/* … *\/`. */
const LINE_COMMENT = /^[ \t]*(?:\/\/[^\r\n]*|\/\*[^\r\n]*?\*\/)?/;

/** Where the comma after `from` ends, when the next token there is one, past any blank or comment between them. */
function commaAfter(text: string, from: number): number | undefined {
  const scanner = createScanner(text, true);

  scanner.setPosition(from);

  return scanner.scan() === SyntaxKind.CommaToken ? scanner.getTokenOffset() + scanner.getTokenLength() : undefined;
}

/** The node at `path` in `text`, read as `jsonc`, which accepts every syntax `editJsonText` edits. */
function nodeAt(text: string, path: JSONPath): Node | undefined {
  const root = parseTree(text, [], { allowTrailingComma: true });

  return root === undefined ? undefined : findNodeAtLocation(root, path);
}

/** `text` without the property or element at `path`, as `editJsonText` removes one. */
function withoutNode(text: string, path: JSONPath): string {
  const value = nodeAt(text, path);
  const node = value?.parent?.type === 'property' ? value.parent : value;
  const siblings = node?.parent?.children;

  if (node === undefined || siblings === undefined) return text;
  let start = node.offset;
  let end = node.offset + node.length;
  const ownComma = commaAfter(text, end);

  if (ownComma !== undefined) end = ownComma;
  end += LINE_COMMENT.exec(text.slice(end))?.[0].length ?? 0;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = /^[ \t]*(?:\r?\n|$)/.exec(text.slice(end));

  if (lineEnd && /^[ \t]*$/.test(text.slice(lineStart, start))) {
    start = lineStart;
    end += lineEnd[0].length;

  } else {
    end += /^[ \t]*/.exec(text.slice(end))?.[0].length ?? 0;
  }

  const removed = text.slice(0, start) + text.slice(end);
  const index = siblings.indexOf(node);
  const previous = index > 0 ? siblings[index - 1] : undefined;

  // The last one goes with no comma of its own: the one before it loses the comma that would now trail.
  if (ownComma !== undefined || previous === undefined || index !== siblings.length - 1) return removed;
  const comma = commaAfter(removed, previous.offset + previous.length);

  return comma === undefined ? removed : removed.slice(0, comma - 1) + removed.slice(comma);
}

/**
 * `text` with `value` (under `key`, in an object) added after the last member
 * of the container at `path`, on its own line with that member's indentation,
 * or null when the container is empty or missing, or its last member does not
 * start its line: `modify` handles those without touching a member.
 */
function withAppended(text: string, path: JSONPath, key: string | null, value: JsonValue, formattingOptions: FormattingOptions): string | null {
  const container = nodeAt(text, path);
  const last = container?.children?.at(-1);

  if (last === undefined) return null;
  const lineStart = text.lastIndexOf('\n', last.offset - 1) + 1;
  const indent = text.slice(lineStart, last.offset);

  if (!/^[ \t]*$/.test(indent)) return null;
  const unit = formattingOptions.insertSpaces === false ? '\t' : ' '.repeat(formattingOptions.tabSize ?? 2);
  const eol = formattingOptions.eol ?? '\n';
  const rendered = (key === null ? '' : `${JSON.stringify(key)}: `) + JSON.stringify(value, null, unit).split('\n').join(`${eol}${indent}`);
  let at = last.offset + last.length;
  const comma = commaAfter(text, at);

  // Same-line comments after the member, through the last one: `/* … */ // …` stays on that line.
  const lineComment = (from: number): number => {
    let past = from;
    let length = LINE_COMMENT.exec(text.slice(past))?.[0].length ?? 0;

    while (length > 0) {
      past += length;
      length = LINE_COMMENT.exec(text.slice(past))?.[0].length ?? 0;
    }

    return past;
  };

  // A member list written with a trailing comma keeps one.
  if (comma !== undefined) {
    at = lineComment(comma);

    return `${text.slice(0, at)}${eol}${indent}${rendered},${text.slice(at)}`;
  }

  const lineEnd = lineComment(at);

  return `${text.slice(0, at)},${text.slice(at, lineEnd)}${eol}${indent}${rendered}${text.slice(lineEnd)}`;
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
