import { defineRule } from '@oxlint/plugins';

import { lintedPath } from '../utils.js';

function isLearningsSegment(node) {
  return node.type === 'Literal' && (node.value === 'learnings' || node.value === '/learnings');
}

/** Require production callers to use the shared learnings-root accessor (#485). */
export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Use the shared accessor instead of rebuilding a learnings root path.' },
  },
  create(context) {
    const file = lintedPath(context);
    if (!file.includes('/src/') || file.includes('/src/__tests__/')) return {};

    return {
      CallExpression(node) {
        if (node.callee.type !== 'MemberExpression'
          || node.callee.object.type !== 'Identifier'
          || node.callee.object.name !== 'path'
          || node.callee.property.type !== 'Identifier'
          || !['join', 'resolve'].includes(node.callee.property.name)
          || !node.arguments.some(isLearningsSegment)) return;
        context.report({
          node,
          message: 'Use learningsRoots(localConfig) instead of rebuilding a learnings root. If this call intentionally defines a raw root, disable this line and say why.',
        });
      },
      TemplateLiteral(node) {
        if (!node.quasis.some((quasi) => quasi.value.raw.includes('/learnings'))) return;
        context.report({
          node,
          message: 'Use learningsRoots(localConfig) instead of building a `/learnings` template path.',
        });
      },
    };
  },
});