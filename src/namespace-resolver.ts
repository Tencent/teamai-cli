/**
 * The namespace rule every team resource type follows (#707):
 *
 *   <type>/        root, shared
 *   <type>/<ns>/   delivered only where <ns> is active (role ∪ project)
 *
 * An active namespace item replaces the root item of the same name, whole.
 * Two items of one name in the same place, or in two active namespaces, are a
 * conflict: nothing says which one a member should receive.
 *
 * Pure. Per-type code parses its files into candidates and applies the result;
 * legacy mode (no roles, no projects) does not come through here.
 */

import type { ResourceItem } from './types.js';

/** One named item read from the team repo. `namespace: null` is the root. */
export interface NamespaceCandidate<T> {
  readonly name: string;
  /** The repo-relative file or directory that defines the item, for messages. */
  readonly source: string;
  readonly namespace: string | null;
  readonly value: T;
}

export interface ResolvedNamespaceItem<T> extends NamespaceCandidate<T> {
  /** The root item this namespace item replaces, or null when it replaces nothing. */
  readonly replaces: NamespaceCandidate<T> | null;
}

export interface NamespaceConflict<T> {
  readonly kind: 'conflict';
  /**
   * `duplicate`: both items are in the root, or both in one namespace (one file
   * or two). `two-namespaces`: they are in two different active namespaces.
   */
  readonly reason: 'duplicate' | 'two-namespaces';
  readonly name: string;
  readonly first: NamespaceCandidate<T>;
  readonly second: NamespaceCandidate<T>;
}

export type NamespaceResolution<T> =
  | { readonly kind: 'resolved'; readonly items: readonly ResolvedNamespaceItem<T>[] }
  | NamespaceConflict<T>;

/** A team-repo resource item as a candidate, named and placed the way the scan found it. */
export function itemCandidate(item: ResourceItem): NamespaceCandidate<ResourceItem> {
  return { name: item.name, source: item.relativePath, namespace: item.namespace ?? null, value: item };
}

/**
 * Resolve candidates against the active namespaces. Candidates in a namespace
 * that is not active are dropped.
 *
 * The result does not depend on the order files were read: `active` is the
 * only order that counts. Items come back root first, then by namespace in
 * `active` order, then by name. When several names conflict, the one reported
 * is the first a reader walking root, then `active` in order, would meet.
 * Candidates with the same namespace and source keep their input order, which
 * is their order inside that file.
 */
export function resolveNamespacedItems<T>(
  candidates: readonly NamespaceCandidate<T>[],
  active: readonly string[],
): NamespaceResolution<T> {
  const rank = (namespace: string | null): number => (namespace === null ? 0 : active.indexOf(namespace) + 1);

  const byPlace = (a: NamespaceCandidate<T>, b: NamespaceCandidate<T>): number => (
    rank(a.namespace) - rank(b.namespace) || compareStrings(a.source, b.source)
  );

  const byName = new Map<string, NamespaceCandidate<T>[]>();

  for (const candidate of candidates) {
    if (candidate.namespace !== null && !active.includes(candidate.namespace)) continue;
    const group = byName.get(candidate.name);

    if (group) group.push(candidate);
    else byName.set(candidate.name, [candidate]);
  }

  const items: ResolvedNamespaceItem<T>[] = [];
  const conflicts: NamespaceConflict<T>[] = [];

  for (const [name, group] of byName) {
    const [first, second, third] = group.sort(byPlace);

    if (!first) continue;

    if (!second) {
      items.push({ ...first, replaces: null });
    } else if (first.namespace !== null || second.namespace === null) {
      conflicts.push(conflictBetween(name, first, second));
    } else if (third) {
      // One root item is replaced, not a side of the conflict: the clash is
      // between the namespace items.
      conflicts.push(conflictBetween(name, second, third));
    } else {
      items.push({ ...second, replaces: first });
    }
  }

  const [conflict] = conflicts.sort((a, b) => (
    rank(a.second.namespace) - rank(b.second.namespace) || compareStrings(a.name, b.name)
  ));

  if (conflict) return conflict;

  return {
    kind: 'resolved',
    items: items.sort((a, b) => rank(a.namespace) - rank(b.namespace) || compareStrings(a.name, b.name)),
  };
}

/** A namespace item delivered in place of a root item: its name, and both files repo-relative. */
export interface NamespaceOverride {
  readonly name: string;
  readonly source: string;
  readonly replaces: string;
}

/**
 * Root suppression alone, for types whose namespace items never compete for
 * one slot (rules keep their `rules/<ns>/` path, claudemd files each keep a
 * place in the block): every active namespace item replaces the root item of
 * its name, and two active namespaces with one name are no conflict, so both
 * are delivered.
 */
export function resolveRootOverrides<T>(
  candidates: readonly NamespaceCandidate<T>[],
  active: readonly string[],
): NamespaceOverride[] {
  const roots = new Map(candidates.flatMap((candidate) => (
    candidate.namespace === null ? [[candidate.name, candidate.source] as const] : []
  )));

  return candidates.flatMap((candidate) => {
    const root = candidate.namespace !== null && active.includes(candidate.namespace)
      ? roots.get(candidate.name)
      : undefined;

    return root ? [{ name: candidate.name, source: candidate.source, replaces: root }] : [];
  });
}

/** One override as `doctor` lists it, the same line for every type. */
export function describeOverride(type: string, override: NamespaceOverride): string {
  return `${type}: "${override.name}" from ${override.source} replaces ${override.replaces}`;
}

/** Each name more than one item carries, with those items' sources sorted, in first-seen order. */
export function repeatedNames<T>(
  items: readonly T[],
  nameOf: (item: T) => string,
  sourceOf: (item: T) => string,
): Array<[string, string[]]> {
  const byName = new Map<string, string[]>();

  for (const item of items) {
    const name = nameOf(item);
    byName.set(name, [...(byName.get(name) ?? []), sourceOf(item)]);
  }

  return [...byName].flatMap(([name, sources]): Array<[string, string[]]> => (sources.length > 1 ? [[name, sources.sort()]] : []));
}

function conflictBetween<T>(
  name: string,
  first: NamespaceCandidate<T>,
  second: NamespaceCandidate<T>,
): NamespaceConflict<T> {
  return {
    kind: 'conflict',
    reason: first.namespace === second.namespace ? 'duplicate' : 'two-namespaces',
    name,
    first,
    second,
  };
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;

  return a > b ? 1 : 0;
}
