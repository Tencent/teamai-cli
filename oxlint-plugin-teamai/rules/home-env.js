/** @import { Context } from '@oxlint/plugins' */

import { defineRule } from '@oxlint/plugins';

import { isOneOf, lintedPath } from '../utils.js';

/** The one module that owns raw HOME reads. */
const HOME_OWNER = 'src/utils/home.ts';

/** The legacy source guard scans production source, not its test fixtures.
 * @param {Context} context
 */
function isProductionSource(context) {
  const file = lintedPath(context);
  const inSource = file === 'src' || file.startsWith('src/') || file.includes('/src/');
  return inSource && !file.includes('/src/__tests__/') && !file.startsWith('src/__tests__/');
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Use getUserHome instead of reading process.env.HOME directly.' },
  },
  create(context) {
    if (!isProductionSource(context) || isOneOf(context, [HOME_OWNER])) return {};
    return {
      MemberExpression(node) {
        if (node.object.type !== 'MemberExpression' || node.object.computed) return;
        if (node.object.object.type !== 'Identifier' || node.object.object.name !== 'process') return;
        if (node.object.property.type !== 'Identifier' || node.object.property.name !== 'env') return;
        const readsHome = node.computed
          ? node.property.type === 'Literal' && node.property.value === 'HOME'
          : node.property.type === 'Identifier' && node.property.name === 'HOME';
        if (!readsHome) return;
        context.report({
          node,
          message: 'Read the user home through getUserHome() in src/utils/home.ts so USERPROFILE and platform fallbacks remain supported.',
        });
      },
    };
  },
});
