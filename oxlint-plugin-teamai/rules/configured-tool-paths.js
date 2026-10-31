/** @import { Node } from '@oxlint/plugins' */

import { defineRule } from '@oxlint/plugins';

import { lintedPath } from '../utils.js';

/**
 * Whether an expression contains a direct configured tool-path member access.
 * @param {any} value
 * @param {Set<any>} [seen]
 * @returns {boolean}
 */
function mentionsConfiguredPath(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => mentionsConfiguredPath(entry, seen));
  if (value.type === 'MemberExpression'
    && value.computed === false
    && value.property?.type === 'Identifier'
    && ['skills', 'rules', 'claudemd'].includes(value.property.name)) return true;
  return Object.entries(value)
    .filter(([key]) => !['loc', 'parent', 'range', 'tokens', 'comments'].includes(key))
    .some(([, child]) => mentionsConfiguredPath(child, seen));
}

/** Keep configured tool paths behind locate(), which also handles scope and moved tool roots. */
export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Do not join configured tool paths outside locate.ts.' },
  },
  create(context) {
    const file = lintedPath(context);
    if (!file.includes('/src/') || file.includes('/src/__tests__/') || file.endsWith('/src/locate.ts')) return {};
    return {
      CallExpression(node) {
        if (node.callee.type !== 'MemberExpression'
          || node.callee.object.type !== 'Identifier'
          || node.callee.object.name !== 'path'
          || node.callee.property.type !== 'Identifier'
          || !['join', 'resolve'].includes(node.callee.property.name)
          || !mentionsConfiguredPath(node.arguments)) return;
        context.report({
          node,
          message: 'Use locate() instead of joining a configured skills, rules, or claudemd path by hand.',
        });
      },
    };
  },
});