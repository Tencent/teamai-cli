import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';
import { z } from 'zod';

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

  return renderMerged(target, expected, destination, pending, (text) => read(text).values);
}

/** Serialize a merged document, refusing when an alias would resolve differently, and keep the destination's CRLF. */
function renderMerged<T>(
  target: { document: YAML.Document; values: Map<string, T> },
  expected: Map<string, T>,
  destination: string | null,
  pending: string,
  reread: (text: string) => Map<string, T>,
): string {
  if (isDeepStrictEqual(expected, target.values)) return destination ?? pending;
  const merged = target.document.toString();

  // A copied alias may resolve to a different value in the destination document.
  if (!isDeepStrictEqual(reread(merged), expected)) {
    throw new Error('The merged settings cannot be represented safely in the destination YAML.');
  }

  return destination?.includes('\r\n') ? merged.replaceAll('\n', '\r\n') : merged;
}

const envEntryList = z.array(z.looseObject({ key: z.string() }));

type EnvEntry = z.infer<typeof envEntryList>[number];

/**
 * Re-apply local edits to an env yaml file on top of a newer committed copy:
 * each top-level key, and each `key:` entry of a list, takes the side that
 * changed it. Throws when both sides changed the same one differently.
 */
export function mergeEnvFile(base: string | null, pending: string, destination: string): string {
  if (base === destination) return pending;

  const read = (text: string | null) => {
    const document = YAML.parseDocument(text ?? '', { resolveKnownTags: false });

    if (document.errors.length) throw document.errors[0];

    const values = new Map(Object.entries(z.record(z.string(), z.unknown()).parse(document.toJS() ?? {})));

    return { document, values };
  };

  const original = read(base).values;
  const edit = read(pending).values;
  const target = read(destination);
  const expected = new Map(target.values);
  const conflicts: string[] = [];

  for (const name of new Set([...original.keys(), ...edit.keys()])) {
    const before = original.get(name);
    const after = edit.get(name);
    const existing = target.values.get(name);

    if (isDeepStrictEqual(before, after) || isDeepStrictEqual(existing, after)) continue;

    if (isDeepStrictEqual(before, existing)) {
      if (edit.has(name)) {
        target.document.set(name, after);
        expected.set(name, after);
      } else {
        target.document.delete(name);
        expected.delete(name);
      }

      continue;
    }

    const lists = z.tuple([envEntryList, envEntryList, envEntryList]).safeParse([before ?? [], after ?? [], existing ?? []]);

    if (!lists.success) {
      conflicts.push(name);

      continue;
    }

    const [beforeList, afterList, existingList] = lists.data;
    const merged: EnvEntry[] = [...existingList];

    for (const entryKey of new Set([...beforeList, ...afterList].map((entry) => entry.key))) {
      const was = beforeList.find((entry) => entry.key === entryKey);
      const now = afterList.find((entry) => entry.key === entryKey);
      const there = merged.findIndex((entry) => entry.key === entryKey);

      if (isDeepStrictEqual(was, now) || isDeepStrictEqual(merged[there], now)) continue;

      if (!isDeepStrictEqual(was, merged[there])) {
        conflicts.push(`${name}.${entryKey}`);
      } else if (now === undefined) {
        merged.splice(there, 1);
      } else if (there === -1) {
        merged.push(now);
      } else {
        merged[there] = now;
      }
    }

    target.document.set(name, merged);
    expected.set(name, merged);
  }

  if (conflicts.length) throw new Error(`Conflicting entries: ${conflicts.join(', ')}.`);

  return renderMerged(target, expected, destination, pending, (text) => read(text).values);
}
