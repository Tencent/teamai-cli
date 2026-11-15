/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';
import { KNOWN_FAILURE_CODES, PROTOCOL_STRING_CONSTANTS } from '../failure-codes.js';
import { inProductionSource, lintedPath, stringLiteralValue } from '../utils.js';

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Classify workflow failure producers before publishing records.' } },
  create(context) {
    const file = lintedPath(context);

    if (!inProductionSource(context)) return {};

    if (!/\/src\/(?:workflow|scorers)\//.test(file) && !/from ['"](?:\.\.?\/)+scorers\/|\bWorkflowEnvelope\b/.test(context.sourceCode.text)) return {};
    const message = 'List this workflow failure code in FAILURE_CODES (src/workflow/failure-codes.ts) before emitting it, so the run record keeps it.';

    /** @type {Map<string, string>} each local name a constant of `@teamai/runtime-protocol` is imported as, to its name there */
    const protocolImports = new Map();

    return {
      ImportDeclaration(node) {
        if (node.source.value !== '@teamai/runtime-protocol' && !node.source.value.startsWith('@teamai/runtime-protocol/')) return;

        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier') protocolImports.set(specifier.local.name, specifier.imported.name);
        }
      },
      // A code a step takes from the protocol's constants reaches the record as its value, which must be listed too.
      Property(node) {
        if (node.key.type !== 'Identifier' || node.key.name !== 'code' || node.value.type !== 'Identifier') return;
        const imported = protocolImports.get(node.value.name);

        if (imported === undefined) return;
        const value = PROTOCOL_STRING_CONSTANTS.get(imported);

        if (value === undefined || !KNOWN_FAILURE_CODES.has(value)) context.report({ node: node.value, message });
      },
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
