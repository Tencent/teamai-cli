import { defineRule } from '@oxlint/plugins';

import { lintedPath } from '../utils.js';

const OWNER = '/src/launch-context.ts';
const NAMES = new Set(['TEAMAI_MODE', 'TEAMAI_LAUNCHED_BY', 'TEAMAI_WORKFLOW_ATTEMPT']);

/** Keep workflow launch environment names in launch-context.ts. */
export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Import workflow launch environment names from launch-context.ts.' },
  },
  create(context) {
    const file = lintedPath(context);
    if (!file.includes('/src/') || file.includes('/src/__tests__/') || file.endsWith(OWNER)) return {};
    const message = 'Import the launch environment constant from launch-context.ts instead of repeating its name.';
    return {
      Literal(node) {
        if (typeof node.value === 'string' && NAMES.has(node.value)) context.report({ node, message });
      },
      TemplateLiteral(node) {
        if (node.expressions.length === 0 && NAMES.has(node.quasis[0]?.value.raw ?? '')) context.report({ node, message });
      },
      MemberExpression(node) {
        const property = node.property;
        if (!node.computed && property.type === 'Identifier' && NAMES.has(property.name)) context.report({ node, message });
      },
    };
  },
});
