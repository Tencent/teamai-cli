import type { z } from 'zod';

const FENCE = /```[\w-]*[ \t]*\n?([\s\S]*?)\n?[ \t]*```/g;

/** How much of the reply's end is scanned for JSON written in prose: the scan is quadratic on unclosed brackets. */
const INLINE_TAIL = 16_384;

/**
 * The JSON value an AI tool's reply holds, checked against `schema` (`JsonValueSchema` for any JSON value), or
 * undefined when it holds none that matches.
 *
 * The reply is read as a whole first, then the fenced blocks that hold JSON, last first, then the non-empty JSON
 * objects and arrays written in the last 16 KiB of prose, last first: the first one `schema` accepts wins, and a list
 * it rejects offers its items. So a reply that explains itself before or after its answer, quotes an example after
 * it, or wraps it in a list still counts.
 */
export function extractReply<T>(text: string, schema: z.ZodType<T>): T | undefined {
  for (const value of candidatesOf(text)) {
    const parsed = schema.safeParse(value);

    if (parsed.success) return parsed.data;

    if (!Array.isArray(value)) continue;

    for (const item of value.toReversed()) {
      const inList = schema.safeParse(item);

      if (inList.success) return inList.data;
    }
  }

  return undefined;
}

function* candidatesOf(text: string): Generator<unknown> {
  const whole = jsonOf(text);

  if (whole !== undefined) yield whole.value;

  for (const match of [...text.matchAll(FENCE)].toReversed()) {
    const fenced = jsonOf(match[1] ?? '');

    if (fenced !== undefined) yield fenced.value;
  }

  for (const inline of inlineValuesOf(text).toReversed()) yield inline;
}

function jsonOf(text: string): { value: unknown } | undefined {
  const trimmed = text.trim();

  if (trimmed === '') return undefined;

  try {
    return { value: JSON.parse(trimmed) };
  } catch {
    return undefined;
  }
}

/** Every non-empty top-level `{…}` or `[…]` in the end of the prose that parses as JSON, in order. */
function inlineValuesOf(text: string): unknown[] {
  const values: unknown[] = [];

  for (let start = Math.max(0, text.length - INLINE_TAIL); start < text.length; start++) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    const end = closingOf(text, start);

    if (end === undefined) continue;
    const written = text.slice(start, end + 1);
    const found = jsonOf(written);

    if (found === undefined) continue;

    // An empty list or object in prose is a checkbox or a placeholder, not an answer.
    if (!/^[[{]\s*[\]}]$/.test(written)) values.push(found.value);
    start = end;
  }

  return values;
}

/** Where the bracket opened at `start` closes, skipping brackets inside JSON strings, or undefined when it never does. */
function closingOf(text: string, start: number): number | undefined {
  const open: string[] = [];
  let inString = false;

  for (let at = start; at < text.length; at++) {
    const char = text[at];

    if (inString) {
      if (char === '\\') at++;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') open.push('}');
    else if (char === '[') open.push(']');
    else if (char === '}' || char === ']') {
      if (open.pop() !== char) return undefined;

      if (open.length === 0) return at;
    }
  }

  return undefined;
}
