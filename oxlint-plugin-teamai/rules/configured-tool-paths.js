/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';
import { inProductionSource, isOneOf } from '../utils.js';

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Resolve configured tool paths through locate.' } },
  create(context) {
    if (!inProductionSource(context) || isOneOf(context, ['src/locate.ts'])) return {};
    const reported = new Set();
    return {
      MemberExpression(node) {
        const property = node.computed && node.property.type === 'Literal' ? node.property.value
          : !node.computed && node.property.type === 'Identifier' ? node.property.name : undefined;
        if (property !== 'skills' && property !== 'rules' && property !== 'claudemd') return;
        /** @type {ESTree.Node | null} */
        let parent = node.parent;
        for (; parent !== null; parent = parent.parent) {
          if (parent.type !== 'CallExpression') continue;
          const callee = parent.callee;
          const operation = callee.type === 'Identifier' ? callee.name
            : callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'path' && callee.property.type === 'Identifier' ? callee.property.name : undefined;
          if ((operation !== 'join' && operation !== 'resolve') || reported.has(parent)) continue;
          reported.add(parent);
          context.report({ node: parent, message: 'Resolve configured skills, rules and claudemd paths through locate() in src/locate.ts.' });
        }
      },
    };
  },
});
