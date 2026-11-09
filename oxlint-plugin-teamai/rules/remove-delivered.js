import path from 'node:path';

import { defineRule } from '@oxlint/plugins';

import { isOneOf, sourcePath } from '../utils.js';

/** Pull's own file, beside every file under `src/resources/`, where pull delivers and deletes copies (#1577, #1787). */
const PULL_FILE = 'src/pull.ts';
const RESOURCES_DIR = 'src/resources/';

const MESSAGE = 'Delete a delivered copy with removeDelivered(ledger, dest): it also takes the copy off the delivery record, and a bare remove( leaves a stale entry. For a path pull never records, such as a team-repo file, disable this line and say why.';

/**
 * Whether the module `source`, imported from the linted file at `file`, is fs-extra or `src/utils/fs`.
 * @param {string} source
 * @param {string} file
 * @returns {boolean}
 */
function removesFiles(source, file) {
  if (source === 'fs-extra') return true;

  if (!source.startsWith('.')) return false;
  const resolved = path.posix.join(path.posix.dirname(file), source).replace(/\.[jt]s$/, '');

  return resolved === 'src/utils/fs';
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Delete a delivered copy and its delivery record entry in one call, removeDelivered.' },
  },
  create(context) {
    const file = sourcePath(context);

    if (!isOneOf(context, [PULL_FILE]) && !file.startsWith(RESOURCES_DIR)) return {};
    /** @type {Set<string>} Local names bound to `remove` itself. */
    const removes = new Set();
    /** @type {Set<string>} Local names bound to the module: `import fse from 'fs-extra'`, `import * as fsu from '../utils/fs.js'`. */
    const modules = new Set();

    return {
      ImportDeclaration(node) {
        if (!removesFiles(node.source.value, file)) return;

        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ImportSpecifier') {
            modules.add(specifier.local.name);
            continue;
          }

          const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;

          if (imported === 'remove') removes.add(specifier.local.name);
        }
      },
      CallExpression(node) {
        const { callee } = node;

        const isRemove = callee.type === 'Identifier'
          ? removes.has(callee.name)
          : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && modules.has(callee.object.name)
            && callee.property.type === 'Identifier' && callee.property.name === 'remove';

        if (isRemove) context.report({ node, message: MESSAGE });
      },
    };
  },
});
