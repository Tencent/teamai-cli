/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { importVisitors } from '../imports.js';
import { FAMILY, PROCESS_STARTERS, lintedPath } from '../utils.js';

/**
 * The linted file as `{ relative, index }` when it is a tool family's production source, else undefined: `relative`
 * from the repository root, and `index` whether it is the family's entry. Tests and `src/testing/` are out of scope.
 * @param {string} file
 */
export function familySource(file) {
  const match = /(?:^|\/)(packages\/([^/]+)\/src\/(.+\.[cm]?[jt]sx?))$/.exec(file);

  if (!match) return undefined;
  const [, relative = '', folder = '', rest = ''] = match;

  if (!FAMILY.test(folder) || rest.startsWith('testing/') || /\.test\.[cm]?[jt]sx?$/.test(rest)) return undefined;

  return { relative, index: /^index\.[cm]?[jt]sx?$/.test(rest) };
}

/**
 * The names an export declaration makes public.
 * @param {ESTree.ExportNamedDeclaration} node
 * @returns {string[]}
 */
function exportedNames(node) {
  const { declaration } = node;

  if (declaration === null || declaration === undefined) {
    return node.specifiers.map((specifier) => (specifier.exported.type === 'Identifier' ? specifier.exported.name : String(specifier.exported.value)));
  }

  if (declaration.type === 'VariableDeclaration') {
    return declaration.declarations.map((declarator) => (declarator.id.type === 'Identifier' ? declarator.id.name : '(a destructured binding)'));
  }

  return 'id' in declaration && declaration.id?.type === 'Identifier' ? [declaration.id.name] : ['(an unnamed declaration)'];
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Keep a tool family to data and readers: it builds argv and never starts a process, and its index.ts exports only `family`.' },
    schema: [],
  },
  create(context) {
    const source = familySource(lintedPath(context));

    if (source === undefined) return {};

    /** @param {ESTree.Node} node @param {string} what */
    const starts = (node, what) => {
      context.report({ node, message: `A tool family builds argv and reads output, and never starts a process: ${source.relative} ${what}. Return the argv from the family's launch profile and let @teamai/tool-launch run it through the port its caller gives.` });
    };

    const imports = importVisitors(({ node, specifier, typeOnly }) => {
      if (!typeOnly && PROCESS_STARTERS.has(specifier)) starts(node, `imports ${specifier}`);
    });

    /** @param {ESTree.Node} node @param {string} what */
    const exportsMore = (node, what) => {
      context.report({ node, message: `A tool family's index.ts exports only \`family\`, which the app reads through @teamai/tool-definitions: ${source.relative} ${what}. Make it a field of \`family\`, or keep it inside the package.` });
    };

    return {
      ...imports,
      /** @param {ESTree.ExportNamedDeclaration} node */
      ExportNamedDeclaration(node) {
        imports.ExportNamedDeclaration(node);

        if (!source.index || node.exportKind === 'type') return;
        const extra = exportedNames(node).filter((name) => name !== 'family');

        if (extra.length > 0) exportsMore(node, `also exports ${extra.join(', ')}`);
      },
      /** @param {ESTree.ExportAllDeclaration} node */
      ExportAllDeclaration(node) {
        imports.ExportAllDeclaration(node);

        if (source.index && node.exportKind !== 'type') exportsMore(node, 'has an export *');
      },
      ExportDefaultDeclaration(/** @type {ESTree.ExportDefaultDeclaration} */ node) {
        if (source.index) exportsMore(node, 'has an export default');
      },
    };
  },
});
