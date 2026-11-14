import { defineRule } from '@oxlint/plugins';
import path from 'node:path';
import { importVisitors } from '../imports.js';
import { lintedPath, scopedFiles, sourcePath, workspaceFile, workspaceRoot } from '../utils.js';

/**
 * What `teamai` (src/bin.ts, the tsup `index` entry) loads before the compile
 * cache is on and the CLI bundle is imported: every hook pays for it, and the
 * hook fast path exits on it alone (#1788). Paths are from the repository root.
 */
export const UNCACHED = new Set(scopedFiles([
  'src/bin.ts',
  'src/hook-fast-path.ts',
  'src/utils/hook-stdin.ts',
  'packages/shared/src/debug-log.ts',
  'packages/shared/src/home.ts',
]));

export default defineRule({
  meta: { type: 'problem', docs: { description: 'What runs before the CLI bundle imports only node: modules and itself.' } },
  create(context) {
    const file = lintedPath(context);
    const root = workspaceRoot(path.posix.dirname(file));
    const from = root === undefined ? sourcePath(context) : path.posix.relative(root, file);

    if (!UNCACHED.has(from)) return {};

    return importVisitors(({ node, specifier, typeOnly }) => {
      if (typeOnly || specifier.startsWith('node:')) return;

      const to = specifier.startsWith('.')
        ? path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)).replace(/\.js$/, '.ts')
        : root === undefined ? undefined : workspaceFile(root, specifier);

      if (to !== undefined && UNCACHED.has(to)) return;

      context.report({
        node,
        message: `${from} runs before the CLI bundle loads, for every hook (#1788), so it imports only node: modules and the files in UNCACHED `
          + `(oxlint-plugin-teamai/rules/uncached-entry.js). Import ${specifier} from code the CLI bundle runs instead, `
          + 'or add a file to UNCACHED once it imports nothing else.',
      });
    });
  },
});
