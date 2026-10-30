import { defineRule } from '@oxlint/plugins';

import { isOneOf, lintedPath } from '../utils.js';

const ALLOWED_FILES = [
  'src/utils/learnings-roots.ts',
  'src/utils/learnings-publish.ts',
  'src/utils/pending-learnings.ts',
  'src/types.ts',
  'src/init.ts',
];
const OPT_OUT = /\/\/ learnings-root ok: \S/;

/** Move the existing source guard into the lint phase without changing its boundary. */
export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Use one shared accessor for learnings root paths.' },
  },
  create(context) {
    const file = lintedPath(context);
    if (!file.includes('/src/') || file.includes('/src/__tests__/') || isOneOf(context, ALLOWED_FILES)) return {};

    const lines = context.sourceCode.text.split('\n');
    /** @param {number} line */
    const isOptedOut = (line) => OPT_OUT.test(lines[line - 1] ?? '') || OPT_OUT.test(lines[line - 2] ?? '');
    const message = 'Use learningsRoots(localConfig) instead of rebuilding a learnings root.';

    return {
      CallExpression(node) {
        if (isOptedOut(node.loc.start.line)
          || node.callee.type !== 'MemberExpression'
          || node.callee.object.type !== 'Identifier'
          || node.callee.object.name !== 'path'
          || node.callee.property.type !== 'Identifier'
          || !['join', 'resolve'].includes(node.callee.property.name)
          || !node.arguments.some((argument) => argument.type === 'Literal'
            && (argument.value === 'learnings' || argument.value === '/learnings'))) return;
        context.report({ node, message });
      },
      TemplateLiteral(node) {
        if (isOptedOut(node.loc.start.line)
          || node.expressions.length === 0
          || node.quasis.at(-1)?.value.raw !== '/learnings') return;
        context.report({ node, message });
      },
    };
  },
});
