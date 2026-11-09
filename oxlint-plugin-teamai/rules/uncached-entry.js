import { defineRule } from '@oxlint/plugins';
import path from 'node:path';
import { importVisitors } from '../imports.js';
import { sourcePath } from '../utils.js';

/**
 * What `teamai` (src/bin.ts, the tsup `index` entry) loads before the compile
 * cache is on and the CLI bundle is imported: every hook pays for it, and the
 * hook fast path exits on it alone (#1788).
 */
export const UNCACHED = new Set([
  'src/bin.ts',
  'src/hook-fast-path.ts',
  'src/utils/debug-log.ts',
  'src/utils/home.ts',
  'src/utils/hook-stdin.ts',
]);

export default defineRule({
  meta: { type: 'problem', docs: { description: 'What runs before the CLI bundle imports only node: modules and itself.' } },
  create(context) {
    const from = sourcePath(context);

    if (!UNCACHED.has(from)) return {};

    return importVisitors(({ node, specifier, typeOnly }) => {
      if (typeOnly || specifier.startsWith('node:')) return;
      const to = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)).replace(/\.js$/, '.ts');

      if (specifier.startsWith('.') && UNCACHED.has(to)) return;
      context.report({
        node,
        message: `${from} runs before the CLI bundle loads, for every hook (#1788), so it imports only node: modules and the files in UNCACHED `
          + `(oxlint-plugin-teamai/rules/uncached-entry.js). Import ${specifier} from code the CLI bundle runs instead, `
          + 'or add a file to UNCACHED once it imports nothing else.',
      });
    });
  },
});
