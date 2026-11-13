import fs from 'node:fs';
import path from 'node:path';
import { defineRule } from '@oxlint/plugins';
import { z } from 'zod';

import { importVisitors } from '../imports.js';
import { lintedPath } from '../utils.js';

const ExportsSchema = z.object({ exports: z.union([z.string().transform((target) => ({ '.': target })), z.record(z.string(), z.string())]).optional() });

/**
 * The files a package's `exports` map names, relative to its folder.
 * @param {string} root
 * @returns {Set<string>}
 */
function exported(root) {
  const manifest = ExportsSchema.safeParse(JSON.parse(fs.readFileSync(path.posix.join(root, 'package.json'), 'utf8')));
  const targets = Object.values((manifest.success ? manifest.data.exports : undefined) ?? {});

  return new Set(targets.map((target) => `./${path.posix.normalize(target)}`));
}

/**
 * `file` with a TypeScript extension for the `.js` an ESM import names.
 * @param {string} file
 */
function sourceOf(file) {
  return file.replace(/\.([cm]?)js$/, '.$1ts');
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Test a package through its seams: the module the test is named after, src/testing/, and the package\'s exports.' },
  },
  create(context) {
    const file = lintedPath(context);
    const match = /(?:^|\/)(packages\/[^/]+)\/src\/(.+\.test\.[cm]?[jt]sx?)$/.exec(file);

    if (!match) return {};
    const [, pkg = '', test = ''] = match;
    const root = file.slice(0, file.length - `src/${test}`.length - 1);
    const from = `${pkg}/src/${test}`;
    const own = `src/${test.replace(/\.test(\.[cm]?[jt]sx?)$/, '$1')}`;
    const exports = exported(root);

    return importVisitors(({ node, specifier }) => {
      if (!specifier.startsWith('.')) return;
      const target = sourceOf(path.posix.relative(root, path.posix.resolve(path.posix.dirname(file), specifier)));

      // Another package, or src/, reached by path: package-boundaries owns that.
      if (target.startsWith('..')) return;

      if (target === sourceOf(own) || target.startsWith('src/testing/') || exports.has(`./${target}`)) return;
      context.report({ node, message: `${from} reaches ${target}, past its package's seams. Test it through ${own.replace(/^src\//, './').replace(/\.ts$/, '.js')}, src/testing/ or an entry of the package's exports, or give ${target} a test of its own.` });
    });
  },
});
