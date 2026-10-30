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
const MANUAL_ROOT = /path\.(?:join|resolve)\([^;\n]*\blearnings\b/;
const ABSOLUTE_SUFFIX = /\/learnings\b/;

/** Move the existing source guard into the lint phase without changing its boundary. */
export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Use one shared accessor for learnings root paths.' },
  },
  create(context) {
    const file = lintedPath(context);
    if (!file.includes('/src/') || file.includes('/src/__tests__/') || isOneOf(context, ALLOWED_FILES)) return {};
    return {
      /** @param {any} node */
      Program(node) {
        const lines = context.sourceCode.text.split('\n');
        const offenders = [];
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (OPT_OUT.test(line) || OPT_OUT.test(lines[index - 1] ?? '')) continue;
          if (MANUAL_ROOT.test(line) || ABSOLUTE_SUFFIX.test(line)) {
            offenders.push(`${index + 1}: ${line.trim()}`);
          }
        }
        if (offenders.length > 0) {
          context.report({
            node,
            message: `Use learningsRoots(localConfig) instead of rebuilding a learnings path: ${offenders.join(' | ')}`,
          });
        }
      },
    };
  },
});