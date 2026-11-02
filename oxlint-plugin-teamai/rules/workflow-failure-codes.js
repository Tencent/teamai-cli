/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';
import { KNOWN_FAILURE_CODES } from '../failure-codes.js';
import { inProductionSource, lintedPath, stringLiteralValue } from '../utils.js';

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Classify workflow failure producers before publishing records.' } },
  create(context) {
    const file = lintedPath(context);

    if (!inProductionSource(context)) return {};

    if (!/\/src\/(?:workflow|scorers)\//.test(file) && !/from ['"](?:\.\.?\/)+scorers\/|\bWorkflowEnvelope\b/.test(context.sourceCode.text)) return {};
    const message = 'Classify this workflow failure code in records.ts or the command-only failure policy before emitting it.';

    return {
      Literal(node) {
        const value = stringLiteralValue(node);

        if (value === undefined || KNOWN_FAILURE_CODES.has(value)) return;
        /** @type {ESTree.Node | null} */
        let ancestor = node.parent;

        while (ancestor && ['TSLiteralType', 'TSUnionType', 'TSTypeAnnotation'].includes(ancestor.type)) ancestor = ancestor.parent;

        if ((ancestor?.type === 'Property' || ancestor?.type === 'TSPropertySignature') && ancestor.key.type === 'Identifier' && ancestor.key.name === 'code') context.report({ node, message });
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || !['error', 'failure'].includes(node.callee.name)) return;
        const code = node.arguments[0];

        const value = stringLiteralValue(code);

        if (value !== undefined) {
          if (!KNOWN_FAILURE_CODES.has(value)) context.report({ node, message });
        } else {
          context.report({ node, message: 'Explain this forwarded workflow failure code with an inline disable; its producer must be classified separately.' });
        }
      },
    };
  },
});
