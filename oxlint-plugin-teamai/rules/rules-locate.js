import { defineRule } from '@oxlint/plugins';
import { isOneOf, scopedFiles } from '../utils.js';

const SCOPE = scopedFiles(['src/resources/rules.ts']);
export default defineRule({
  meta: { type: 'problem', docs: { description: 'Keep rules activation independent of MCP paths.' } },
  create(context) {
    if (!isOneOf(context, SCOPE)) return {};
    return {
      CallExpression(node) {
        const resource = node.arguments[1];
        if (node.callee.type === 'Identifier' && node.callee.name === 'locate' && resource?.type === 'Literal' && resource.value === 'mcp') {
          context.report({ node, message: 'Rules activation must locate rules, not MCP paths. Use locate(tool, \'rules\', install, host).' });
        }
      },
    };
  },
});
