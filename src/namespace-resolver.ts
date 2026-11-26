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
import { caseFoldKey } from './manifest-schema.js';

/**
 * Whether `namespace` is one of the `active` namespaces.
 *
 * A declared namespace names its directory case-folded (see
 * `namespaced-entries.namespaceDir`), so `env: [Checkout]` is served by
 * `env/Checkout/` on every filesystem, not only the case-insensitive ones. The
 * same rule holds for every resource type, so a manifest that declares
 * `Frontend` must reach a `skills/frontend/` directory on Linux too. Matching
 * exactly would drop those resources silently, and only on a case-sensitive
 * filesystem, which is why it survives local testing on Windows and macOS.
 *
 * An exact match wins over a case-folded one, mirroring `namespaceDir`: with
 * both `Checkout/` and `checkout/` present, the declared spelling names its own
 * directory.
 */
export function isActiveNamespace(active: readonly string[], namespace: string): boolean {
  if (active.includes(namespace)) return true;

  const folded = caseFoldKey(namespace);

  return active.some((candidate) => caseFoldKey(candidate) === folded);
}

/**
 * The position of `namespace` in `active`, 1-based, or 0 when it is not active.
 * The root has no namespace and ranks 0.
 *
 * An exact match wins over a case-folded one, so a declared spelling keeps its
 * place in `active` order.
 */
export function activeNamespaceRank(active: readonly string[], namespace: string | null): number {
  if (namespace === null) return 0;

  const exact = active.indexOf(namespace);

  if (exact >= 0) return exact + 1;

  const folded = caseFoldKey(namespace);
  const index = active.findIndex((candidate) => caseFoldKey(candidate) === folded);

  return index < 0 ? 0 : index + 1;
}

/**
 * The directory each active declaration actually owns among `directories`.
 *
 * `isActiveNamespace` answers whether a directory may be delivered at all; this
 * answers which one directory a declaration names. The distinction matters when
 * two directories differ only by case: `isActiveNamespace` accepts both, which
 * would make them compete for one declaration and turn a delivery that used to
 * succeed into a `two-namespaces` conflict. The exact spelling wins, as it does
 * in `namespaced-entries.namespaceDir`, and the folded sibling is left out.
 *
 * A declaration no directory answers owns none, which is what `pull` already
 * reports when it lists the namespace and finds nothing.
 */
export function declaredDirectories(
  active: readonly string[],
  directories: readonly string[],
): Set<string> {
  const present = new Set(directories);
  // Sorted so which folded sibling a declaration claims cannot depend on the
  // order the filesystem happened to list them in.
  const sorted = [...present].sort(compareStrings);
  const owned = new Set<string>();

  for (const declared of active) {
    if (present.has(declared)) {
      owned.add(declared);

      continue;
    }

    const folded = caseFoldKey(declared);
    const match = sorted.find((directory) => caseFoldKey(directory) === folded);

    if (match !== undefined) owned.add(match);
  }

  return owned;
}

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
  const rank = (namespace: string | null): number => activeNamespaceRank(active, namespace);

  const byPlace = (a: NamespaceCandidate<T>, b: NamespaceCandidate<T>): number => (
    rank(a.namespace) - rank(b.namespace) || compareStrings(a.source, b.source)
  );

  const byName = new Map<string, NamespaceCandidate<T>[]>();

  // One directory per declaration, exact spelling first: two directories that
  // differ only by case must not both answer for one declaration, or the item
  // they share would be reported as a `two-namespaces` conflict instead of
  // delivering the exact copy, which is what happened before folding matched.
  const owned = declaredDirectories(active, candidates.flatMap((candidate) => (
    candidate.namespace === null ? [] : [candidate.namespace]
  )));

  for (const candidate of candidates) {
    if (candidate.namespace !== null && !owned.has(candidate.namespace)) continue;
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

  const conflict = firstConflict(conflicts, active);

  if (conflict) return conflict;

  return {
    kind: 'resolved',
    items: items.sort((a, b) => rank(a.namespace) - rank(b.namespace) || compareStrings(a.name, b.name)),
  };
}

/**
 * The conflict `resolveNamespacedItems` reports among several, for a caller that resolves each name on its own: the
 * first a reader walking root, then `active` in order, would meet; then by name.
 */
export function firstConflict<T>(conflicts: readonly NamespaceConflict<T>[], active: readonly string[]): NamespaceConflict<T> | undefined {
  const rank = (namespace: string | null): number => activeNamespaceRank(active, namespace);

  return [...conflicts].sort((a, b) => rank(a.second.namespace) - rank(b.second.namespace) || compareStrings(a.name, b.name))[0];
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

  // One directory per declaration here too: a folded sibling is not delivered,
  // so it must not report itself as replacing a root item.
  const owned = declaredDirectories(active, candidates.flatMap((candidate) => (
    candidate.namespace === null ? [] : [candidate.namespace]
  )));

  return candidates.flatMap((candidate) => {
    const root = candidate.namespace !== null && owned.has(candidate.namespace)
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
