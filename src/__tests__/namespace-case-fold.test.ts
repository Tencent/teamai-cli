import { describe, it, expect } from 'vitest';
import {
  activeNamespaceRank,
  isActiveNamespace,
  resolveNamespacedItems,
  type NamespaceCandidate,
} from '../namespace-resolver.js';

/**
 * A declared namespace names its directory case-folded, as the entry types
 * (env, hooks, mcp, models) already do through `namespaceDir`. The other
 * resource types matched the namespace exactly, so a manifest that declared
 * `Frontend` reached `env/frontend/` but silently dropped
 * `skills/frontend/`, `rules/frontend/` and `agents/frontend/`.
 *
 * The drop was invisible on Windows and macOS, where the filesystem folds the
 * two spellings into one directory, and bit only on a case-sensitive
 * filesystem.
 */

function candidate(name: string, namespace: string | null, source = `${namespace ?? 'root'}/${name}`): NamespaceCandidate<string> {
  return { name, source, namespace, value: source };
}

describe('isActiveNamespace', () => {
  it('matches an exactly declared namespace', () => {
    expect(isActiveNamespace(['frontend'], 'frontend')).toBe(true);
  });

  it('matches a namespace that differs only by case', () => {
    expect(isActiveNamespace(['Frontend'], 'frontend')).toBe(true);
    expect(isActiveNamespace(['frontend'], 'Frontend')).toBe(true);
  });

  it('does not match an unrelated namespace', () => {
    expect(isActiveNamespace(['frontend'], 'backend')).toBe(false);
  });

  it('does not match a namespace that only shares a prefix', () => {
    expect(isActiveNamespace(['front'], 'frontend')).toBe(false);
  });

  it('folds unicode spellings the way a case-insensitive filesystem does', () => {
    // `STRASSE` and `straße` are one name on a case-insensitive filesystem.
    expect(isActiveNamespace(['STRASSE'], 'straße')).toBe(true);
  });
});

describe('activeNamespaceRank', () => {
  it('puts the root first', () => {
    expect(activeNamespaceRank(['a', 'b'], null)).toBe(0);
  });

  it('ranks an active namespace by its position', () => {
    expect(activeNamespaceRank(['a', 'b', 'c'], 'b')).toBe(2);
  });

  it('ranks a namespace that differs only by case by its position', () => {
    expect(activeNamespaceRank(['a', 'Frontend'], 'frontend')).toBe(2);
  });

  it('gives an inactive namespace no rank', () => {
    expect(activeNamespaceRank(['a'], 'b')).toBe(0);
  });
});

describe('resolveNamespacedItems with a case-folded namespace', () => {
  it('keeps an item whose namespace differs from the declaration only by case', () => {
    const result = resolveNamespacedItems(
      [candidate('tdd', 'frontend')],
      ['Frontend'],
    );

    expect(result.kind).toBe('resolved');
    expect(result.kind === 'resolved' && result.items.map((item) => item.name)).toEqual(['tdd']);
  });

  it('still drops an item in a namespace that is not active', () => {
    const result = resolveNamespacedItems(
      [candidate('tdd', 'backend')],
      ['Frontend'],
    );

    expect(result.kind).toBe('resolved');
    expect(result.kind === 'resolved' && result.items).toEqual([]);
  });

  it('lets a case-folded namespace item replace the root item of the same name', () => {
    const result = resolveNamespacedItems(
      [candidate('tdd', null, 'root/tdd'), candidate('tdd', 'frontend', 'frontend/tdd')],
      ['Frontend'],
    );

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.namespace).toBe('frontend');
    expect(result.items[0]?.replaces?.namespace).toBeNull();
  });

  it('keeps the declared spelling when both spellings are active', () => {
    // `active` order decides, and an exact match wins over a folded one.
    expect(activeNamespaceRank(['Frontend', 'frontend'], 'Frontend')).toBe(1);
    expect(activeNamespaceRank(['Frontend', 'frontend'], 'frontend')).toBe(2);
  });
});
