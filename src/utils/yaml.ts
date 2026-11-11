import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';
import { z } from 'zod';

import type { JsonValue } from '../types.js';

/** The warnings the library gives for the YAML 1.1 tags parseYaml reads as what they are written as. */
const READ_AS_WRITTEN = ['set', 'omap', 'pairs', 'binary', 'timestamp', 'js']
  .map((tag) => `Unresolved tag: tag:yaml.org,2002:${tag}`);

/**
 * A YAML document as JSON values. The YAML 1.1 tags `!!set`, `!!omap`, `!!pairs`, `!!binary` and `!!timestamp` stay
 * the mapping, list or string they are written as, instead of becoming a Set, Map, Buffer or Date that a schema over
 * JSON would misread, and without the warning the library prints for each; `!!js`, which only DSH's runtime resolves,
 * stays its source text the same way. Every other warning is printed as YAML.parse prints it, and the first error is
 * thrown. An empty document is null.
 */
export function parseYaml(text: string): JsonValue {
  const document = YAML.parseDocument(text, { resolveKnownTags: false });

  for (const warning of document.warnings) {
    if (!READ_AS_WRITTEN.some((message) => warning.message.startsWith(message))) process.emitWarning(warning);
  }

  if (document.errors.length > 0) throw document.errors[0];

  return document.toJS();
}

/** Apply changed top-level settings while preserving the destination document. */
export function mergeTeamConfig(base: string | null, pending: string, destination: string | null): string {
  if (base !== null && destination === null) throw new Error('The destination removed teamai.yaml.');

  const read = (text: string | null) => {
    const document = YAML.parseDocument(text ?? '', { resolveKnownTags: false });

    if (document.errors.length) throw document.errors[0];

    const values = z.map(z.string(), z.unknown()).parse(document.toJS({ mapAsMap: true }) ?? new Map());

    return { document, values };
  };

  const original = read(base).values;
  const edit = read(pending);

  if (base === destination) return pending;

  const target = read(destination);
  const expected = new Map(target.values);
  const conflicts: string[] = [];

  for (const key of new Set([...original.keys(), ...edit.values.keys()])) {
    const before = original.get(key);
    const after = edit.values.get(key);
    const existing = target.values.get(key);

    if (isDeepStrictEqual(before, after) || isDeepStrictEqual(existing, after)) continue;

    if (!isDeepStrictEqual(before, existing)) {
      conflicts.push(key);

      continue;
    }

    if (edit.values.has(key)) {
      target.document.set(key, edit.document.get(key, true));
      expected.set(key, after);
    } else {
      target.document.delete(key);
      expected.delete(key);
    }
  }

  if (conflicts.length) throw new Error(`Conflicting keys: ${conflicts.join(', ')}.`);

  if (isDeepStrictEqual(expected, target.values)) return destination ?? pending;
  const merged = target.document.toString();

  // A copied alias may resolve to a different value in the destination document.
  if (!isDeepStrictEqual(read(merged).values, expected)) {
    throw new Error('The merged settings cannot be represented safely in the destination YAML.');
  }

  return destination?.includes('\r\n') ? merged.replaceAll('\n', '\r\n') : merged;
}
