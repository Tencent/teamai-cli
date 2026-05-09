import { describe, it, expect } from 'vitest';
import type { ResourceItem } from '../types.js';
import { filterRulesByKnowledgeNamespaces } from '../pull.js';

describe('filterRulesByKnowledgeNamespaces', () => {
  function makeRule(name: string): ResourceItem {
    return {
      name,
      type: 'rules',
      sourcePath: `/fake/repo/rules/${name}.md`,
      relativePath: `rules/${name}.md`,
    };
  }

  it('should include rules whose namespace is in activeNamespaces.knowledge', () => {
    const rules = [
      makeRule('common/coding-style'),
      makeRule('hai_dev/deploy-guide'),
    ];
    const knowledgeNamespaces = ['common', 'hai_dev'];

    const result = filterRulesByKnowledgeNamespaces(rules, knowledgeNamespaces);

    expect(result.map((r) => r.name)).toEqual([
      'common/coding-style',
      'hai_dev/deploy-guide',
    ]);
  });

  it('should exclude rules whose namespace is NOT in activeNamespaces.knowledge', () => {
    const rules = [
      makeRule('common/coding-style'),
      makeRule('cvm_dev/workflow'),
      makeRule('cvm/testing'),
    ];
    const knowledgeNamespaces = ['common', 'hai_dev'];

    const result = filterRulesByKnowledgeNamespaces(rules, knowledgeNamespaces);

    expect(result.map((r) => r.name)).toEqual(['common/coding-style']);
  });

  it('should always include root-level rules (no namespace subdirectory)', () => {
    const rules = [
      makeRule('teamai-push-guidelines'),
      makeRule('common/coding-style'),
      makeRule('cvm_dev/workflow'),
    ];
    const knowledgeNamespaces = ['common', 'hai_dev'];

    const result = filterRulesByKnowledgeNamespaces(rules, knowledgeNamespaces);

    expect(result.map((r) => r.name)).toEqual([
      'teamai-push-guidelines',
      'common/coding-style',
    ]);
  });

  it('should return all rules when knowledgeNamespaces is null (no role configured)', () => {
    const rules = [
      makeRule('teamai-push-guidelines'),
      makeRule('common/coding-style'),
      makeRule('cvm_dev/workflow'),
      makeRule('hai_dev/deploy-guide'),
    ];

    const result = filterRulesByKnowledgeNamespaces(rules, null);

    expect(result).toEqual(rules);
  });
});
