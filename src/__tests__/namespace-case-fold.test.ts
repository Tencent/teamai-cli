import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  activeNamespaceRank,
  declaredDirectories,
  isActiveNamespace,
  resolveNamespacedItems,
  type NamespaceCandidate,
} from '../namespace-resolver.js';
import { filterRulesByKnowledgeNamespaces } from '../resources/desired.js';
import { readTeamSkillIndex } from '../resources/skills.js';
import type { LocalConfig, ResourceItem } from '../types.js';

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

describe('declaredDirectories', () => {
  it('claims the exact directory when the declaration spells one', () => {
    expect([...declaredDirectories(['Frontend'], ['Frontend', 'frontend'])]).toEqual(['Frontend']);
  });

  it('claims the folded directory when no exact one exists', () => {
    expect([...declaredDirectories(['Frontend'], ['frontend'])]).toEqual(['frontend']);
  });

  it('claims nothing when no directory answers the declaration', () => {
    expect(declaredDirectories(['Frontend'], ['backend']).size).toBe(0);
  });

  it('does not let two declarations claim one directory twice', () => {
    // Only `Frontend/` exists, so both declarations resolve to it; the set holds
    // one entry and no delivery doubles up.
    const owned = declaredDirectories(['Frontend', 'frontend'], ['Frontend']);
    expect([...owned]).toEqual(['Frontend']);
  });

  it('gives each declaration its own directory on a case-sensitive filesystem', () => {
    const owned = declaredDirectories(['Frontend', 'backend'], ['frontend', 'backend']);
    expect([...owned].sort()).toEqual(['backend', 'frontend']);
  });
});

describe('resolveNamespacedItems keeps the exact directory when both spellings exist', () => {
  /**
   * Regression: with `Frontend/` and `frontend/` both on disk, folding accepted
   * both, they competed for the one declaration, and the resolution became a
   * `two-namespaces` conflict where it used to deliver the exact copy. A team
   * on a case-sensitive filesystem would have stopped receiving the skill.
   */
  it('delivers the exact copy instead of reporting a conflict', () => {
    const result = resolveNamespacedItems(
      [
        candidate('tdd', 'Frontend', 'skills/Frontend/tdd'),
        candidate('tdd', 'frontend', 'skills/frontend/tdd'),
      ],
      ['Frontend'],
    );

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.namespace).toBe('Frontend');
    expect(result.items[0]?.source).toBe('skills/Frontend/tdd');
  });

  it('delivers the folded copy when it is the only one', () => {
    const result = resolveNamespacedItems([candidate('tdd', 'frontend', 'skills/frontend/tdd')], ['Frontend']);

    expect(result.kind).toBe('resolved');
    expect(result.kind === 'resolved' && result.items[0]?.namespace).toBe('frontend');
  });

  it('still reports a conflict when two genuinely different active namespaces hold one name', () => {
    const result = resolveNamespacedItems(
      [candidate('tdd', 'alpha', 'skills/alpha/tdd'), candidate('tdd', 'beta', 'skills/beta/tdd')],
      ['alpha', 'beta'],
    );

    expect(result.kind).toBe('conflict');
  });

  it('keeps the exact copy replacing the root item when a folded sibling is present', () => {
    const result = resolveNamespacedItems(
      [
        candidate('tdd', null, 'skills/tdd'),
        candidate('tdd', 'Frontend', 'skills/Frontend/tdd'),
        candidate('tdd', 'frontend', 'skills/frontend/tdd'),
      ],
      ['Frontend'],
    );

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.namespace).toBe('Frontend');
    expect(result.items[0]?.replaces?.namespace).toBeNull();
  });
});

describe('filterRulesByKnowledgeNamespaces keeps one directory per declaration', () => {
  const rule = (name: string): ResourceItem => ({
    name,
    type: 'rules',
    sourcePath: `/repo/rules/${name}`,
    relativePath: `rules/${name}`,
  });

  /**
   * Regression: folding alone accepted `rules/Frontend/` and `rules/frontend/`,
   * so a member received instructions from a directory nothing had selected.
   */
  it('delivers the declared directory and not the folded sibling', () => {
    const kept = filterRulesByKnowledgeNamespaces(
      [rule('Frontend/style'), rule('frontend/style'), rule('backend/style'), rule('root-rule')],
      ['Frontend'],
      ['Frontend', 'frontend', 'backend'],
    );

    expect(kept.map((item) => item.name)).toEqual(['Frontend/style', 'root-rule']);
  });

  it('delivers a folded directory when the declaration has no exact one', () => {
    const kept = filterRulesByKnowledgeNamespaces([rule('frontend/style'), rule('backend/style')], ['Frontend'], ['frontend', 'backend']);

    expect(kept.map((item) => item.name)).toEqual(['frontend/style']);
  });

  /**
   * Regression: the directory list was derived from the rules found, so an empty
   * `rules/Frontend/` did not appear and the declaration fell through to
   * `rules/frontend/`, delivering instructions nothing had selected.
   */
  it('does not deliver the folded sibling when the exact directory exists but is empty', () => {
    const kept = filterRulesByKnowledgeNamespaces([rule('frontend/style')], ['Frontend'], ['Frontend', 'frontend']);

    expect(kept).toEqual([]);
  });

  it('always keeps root rules', () => {
    const kept = filterRulesByKnowledgeNamespaces([rule('root-rule')], ['Frontend'], ['Frontend']);

    expect(kept.map((item) => item.name)).toEqual(['root-rule']);
  });

  it('passes everything through when no namespace is active', () => {
    const rules = [rule('Frontend/style'), rule('backend/style'), rule('root-rule')];

    expect(filterRulesByKnowledgeNamespaces(rules, null, [])).toEqual(rules);
  });
});

describe('readTeamSkillIndex records the on-disk directory', () => {
  const SKILL = '---\nname: tdd\ndescription: Test-driven development\n---\n\n# TDD\n';

  async function repoWith(dirs: string[]): Promise<string> {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-skill-index-'));

    for (const dir of dirs) {
      const full = path.join(repo, 'skills', dir, 'tdd');
      await fs.mkdir(full, { recursive: true });
      await fs.writeFile(path.join(full, 'SKILL.md'), SKILL, 'utf8');
    }

    return repo;
  }

  /**
   * Regression: the index stored the declared spelling, so an edit pushed to
   * `skills/Frontend/tdd/` created a second directory beside the
   * `skills/frontend/tdd/` the skill was read from.
   */
  it('stores the directory name, not the declaration', async () => {
    const repo = await repoWith(['frontend']);
    const index = await readTeamSkillIndex(repo, ['Frontend']);

    expect(index.teamSkills.get('tdd')?.namespace).toBe('frontend');
  });

  it('stores the exact directory when both spellings exist', async () => {
    const repo = await repoWith(['Frontend', 'frontend']);
    const index = await readTeamSkillIndex(repo, ['Frontend']);

    const copies = index.allTeamSkills.get('tdd') ?? [];
    const kept = copies.filter((copy) => copy.namespace === 'Frontend' || copy.namespace === 'frontend');

    expect(kept.length).toBeGreaterThan(0);
    expect(index.teamSkills.get('tdd')?.namespace).toBe('Frontend');
  });
});
