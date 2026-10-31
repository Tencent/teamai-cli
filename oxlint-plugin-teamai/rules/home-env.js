
import { defineRule } from '@oxlint/plugins';

import { inProductionSource, isOneOf } from '../utils.js';

/** The one module that owns raw HOME reads. */
const HOME_OWNER = 'src/utils/home.ts';

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Use getUserHome instead of reading process.env.HOME directly.' },
  },
  create(context) {
    if (!inProductionSource(context) || isOneOf(context, [HOME_OWNER])) return {};
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
