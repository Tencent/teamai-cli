import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import { defineRule } from '@oxlint/plugins';

import { lintedPath, stringLiteralValue } from '../utils.js';

/**
 * The source file a relative module specifier resolved from `dir` names, as TypeScript resolves it here: `./x.js`,
 * `./x.ts` and `./x` all name `x.ts`, or `x/index.ts`. Undefined when none exists.
 * @param {string} dir
 * @param {string} specifier
 * @returns {string | undefined}
 */
function sourceFile(dir, specifier) {
  const base = path.posix.resolve(dir, specifier).replace(/\.[cm]?[jt]s$/, '');

  return [`${base}.ts`, `${base}/index.ts`].find((candidate) => fs.existsSync(candidate));
}

/** @type {Map<string, string | undefined>} */
const reexports = new Map();

/**
 * The one module `file` re-exports, when re-exporting it is all `file` does; undefined for a file with code of its own,
 * or a barrel over several modules.
 * @param {string} file
 * @returns {string | undefined}
 */
function reexportedModule(file) {
  if (reexports.has(file)) return reexports.get(file);

  const statements = parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['typescript'] }).program.body;

  const sources = new Set(statements.map((statement) => (
    statement.type === 'ExportAllDeclaration' || (statement.type === 'ExportNamedDeclaration' && statement.declaration == null)
      ? statement.source?.value
      : undefined
  )));

  const [only] = sources;
  const reexported = sources.size === 1 ? only : undefined;

  reexports.set(file, reexported);

  return reexported;
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Mock a module where it is defined, not through a module that only re-exports it.' },
  },
  create(context) {
    const dir = path.posix.dirname(lintedPath(context));

    return {
      CallExpression(node) {
        const callee = node.callee;

        if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier' || callee.object.name !== 'vi') return;

        if (callee.property.type !== 'Identifier' || !['mock', 'doMock'].includes(callee.property.name)) return;

        const specifier = stringLiteralValue(node.arguments[0]);

        if (specifier === undefined || !specifier.startsWith('.')) return;
        const mockedFile = sourceFile(dir, specifier);
        const target = mockedFile === undefined ? undefined : reexportedModule(mockedFile);

        if (mockedFile === undefined || target === undefined) return;
        // A relative target is relative to the re-exporting file; the suggestion is written from the test.
        const suggestion = target.startsWith('.') ? `./${path.posix.relative(dir, path.posix.resolve(path.posix.dirname(mockedFile), target))}`.replace(/^\.\/\.\./, '..') : target;

        context.report({
          node,
          message: `Mock the module that defines these exports: '${specifier}' only re-exports '${target}', so this mock misses every module that imports '${target}' itself. Use vi.mock('${suggestion}').`,
        });
      },
    };
  },
});
