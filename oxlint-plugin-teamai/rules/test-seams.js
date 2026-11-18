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
 */
function exported(root) {
  const manifest = ExportsSchema.safeParse(JSON.parse(fs.readFileSync(path.posix.join(root, 'package.json'), 'utf8')));
  const targets = Object.entries((manifest.success ? manifest.data.exports : undefined) ?? {});

  return targets.map(([key, target]) => {
    const file = `./${path.posix.normalize(target)}`;
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const [prefix = '', ...parts] = key.includes('*') ? escaped.split('\\*') : [escaped];
    // Every target wildcard substitutes the same export subpath.
    const pattern = parts.length === 0 ? prefix : `${prefix}(.+)${parts.join('(?:\\1)')}`;

    return { key, target: file, pattern: new RegExp(`^${pattern}$`, 's') };
  }).sort(({ key: a }, { key: b }) => Number(a.includes('*')) - Number(b.includes('*')) || b.indexOf('*') - a.indexOf('*') || b.length - a.length);
}

/** @param {string} file @param {ReturnType<typeof exported>} entries */
function isExported(file, entries) {
  return entries.some(({ key, pattern }) => {
    const match = pattern.exec(file);

    if (match === null) return false;
    const specifier = key.split('*').join(match[1] ?? '*');

    const selected = entries.find(({ key: candidate }) => {
      const [prefix = '', suffix] = candidate.split('*');

      return suffix === undefined ? candidate === specifier : candidate.indexOf('*') === candidate.lastIndexOf('*')
        && specifier.length >= candidate.length && specifier.startsWith(prefix) && specifier.endsWith(suffix);
    });

    if (selected === undefined) return false;
    const index = selected.key.indexOf('*');
    const subpath = specifier.slice(index, specifier.length - (selected.key.length - index - 1));

    return (index === -1 ? selected.target : selected.target.split('*').join(subpath)) === file;
  });
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

      if (target === sourceOf(own) || target.startsWith('src/testing/') || isExported(`./${target}`, exports)) return;
      context.report({ node, message: `${from} reaches ${target}, past its package's seams. Test it through ${own.replace(/^src\//, './').replace(/\.ts$/, '.js')}, src/testing/ or an entry of the package's exports, or give ${target} a test of its own.` });
    });
  },
});
