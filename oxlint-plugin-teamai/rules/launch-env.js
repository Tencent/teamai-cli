import { defineRule } from '@oxlint/plugins';
import { inProductionSource, isOneOf } from '../utils.js';

const VARIABLES = new Set(['TEAMAI_MODE', 'TEAMAI_LAUNCHED_BY', 'TEAMAI_WORKFLOW_ATTEMPT']);
export default defineRule({
  meta: { type: 'problem', docs: { description: 'Keep launch environment variable spellings in launch-context.' } },
  create(context) {
    if (!inProductionSource(context) || isOneOf(context, ['src/launch-context.ts'])) return {};
    const message = 'Import RUN_MODE_ENV, LAUNCHED_BY_ENV or ATTEMPT_ENV from launch-context.ts instead of repeating launch variable names.';
    return {
      Literal(node) {
        if (typeof node.value === 'string' && VARIABLES.has(node.value)) context.report({ node, message });
      },
      TemplateLiteral(node) {
        if (node.expressions.length === 0 && VARIABLES.has(node.quasis[0]?.value.raw ?? '')) context.report({ node, message });
      },
    };
  },
});
