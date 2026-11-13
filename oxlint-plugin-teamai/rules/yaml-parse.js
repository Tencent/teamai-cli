/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { inProductionSource, isOneOf, stringLiteralValue } from '../utils.js';

/** The one module that calls the YAML library's parse. */
const YAML_OWNER = 'packages/shared/src/yaml.ts';

const MESSAGE = 'Parse YAML with parseYaml() from @teamai/shared/yaml: it returns JSON values, where yaml\'s parse turns !!set, !!binary and !!timestamp into a Set, Buffer or Date.';

/**
 * Whether `node` is `import('yaml')`, awaited or not.
 * @param {ESTree.Node | null | undefined} node
 * @returns {boolean}
 */
function isYamlImport(node) {
  const imported = node?.type === 'AwaitExpression' ? node.argument : node;

  return imported?.type === 'ImportExpression' && stringLiteralValue(imported.source) === 'yaml';
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Parse YAML through parseYaml so the result is JSON.' },
  },
  create(context) {
    if (!inProductionSource(context) || isOneOf(context, [YAML_OWNER])) return {};
    /** @type {Set<string>} Local names bound to the yaml module itself: `import YAML from 'yaml'`, `import * as YAML from 'yaml'`, or its dynamic import. */
    const modules = new Set();

    return {
      ImportDeclaration(node) {
        if (node.source.value !== 'yaml') return;

        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportSpecifier') {
            const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;

            if (imported === 'parse') context.report({ node: specifier, message: MESSAGE });
          } else {
            modules.add(specifier.local.name);
          }
        }
      },
      VariableDeclarator(node) {
        const init = node.init?.type === 'AwaitExpression' ? node.init.argument : node.init;

        if (node.id.type === 'Identifier' && init?.type === 'MemberExpression' && isYamlImport(init.object)
          && !init.computed && init.property.type === 'Identifier' && init.property.name === 'default') {
          modules.add(node.id.name);
        }

        if (node.id.type !== 'ObjectPattern' || !isYamlImport(init)) return;

        for (const property of node.id.properties) {
          if (property.type !== 'Property' || property.computed || property.key.type !== 'Identifier') continue;

          if (property.key.name === 'parse') context.report({ node: property, message: MESSAGE });

          if (property.key.name === 'default' && property.value.type === 'Identifier') modules.add(property.value.name);
        }
      },
      MemberExpression(node) {
        if (node.object.type !== 'Identifier' || !modules.has(node.object.name)) return;

        if (!node.computed && node.property.type === 'Identifier' && node.property.name === 'parse') context.report({ node, message: MESSAGE });
      },
    };
  },
});
