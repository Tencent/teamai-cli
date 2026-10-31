import { defineRule } from '@oxlint/plugins';

import { inProductionSource, isOneOf } from '../utils.js';

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Use one shared accessor for learnings root paths.' },
  },
  create(context) {
    if (!inProductionSource(context) || isOneOf(context, ['src/utils/learnings-roots.ts'])) return {};

    const message = 'Use learningsRoots(localConfig) instead of rebuilding a learnings root.';

    return {
      CallExpression(node) {
        if (node.callee.type !== 'MemberExpression'
          || node.callee.object.type !== 'Identifier'
          || node.callee.object.name !== 'path'
          || node.callee.property.type !== 'Identifier'
          || !['join', 'resolve'].includes(node.callee.property.name)
          || !node.arguments.some((argument) => argument.type === 'Literal' && argument.value === 'learnings')) return;
        context.report({ node, message });
      },
      // A `/learnings` suffix however it is attached: joined, concatenated or templated.
      Literal(node) {
        if (node.value === '/learnings') context.report({ node, message });
      },
      TemplateLiteral(node) {
        if (node.quasis.at(-1)?.value.raw === '/learnings') context.report({ node, message });
      },
    };
  },
});
