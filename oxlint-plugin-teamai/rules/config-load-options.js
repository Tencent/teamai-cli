/** @import { ESTree } from '@oxlint/plugins' */

import { defineRule } from '@oxlint/plugins';
import { inProductionSource, isOneOf } from '../utils.js';

const OPTIONS_INDEX = new Map([['loadLocalConfig', 0], ['autoDetectInit', 1], ['loadLocalConfigForScope', 2]]);

/** @param {ESTree.ObjectExpression['properties'][number]} property */
function isPreviewProperty(property) {
  if (property.type === 'SpreadElement') return true;
  return property.key.type === 'Identifier' ? property.key.name === 'dryRun'
    : property.key.type === 'Literal' && property.key.value === 'dryRun';
}

/**
 * @param {ESTree.Expression | ESTree.SpreadElement | undefined} options
 * @returns {boolean}
 */
function hasPreviewPolicy(options) {
  if (!options) return false;
  if (options.type === 'ObjectExpression') {
    return options.properties.some(isPreviewProperty);
  }
  if (options.type === 'ConditionalExpression') return hasPreviewPolicy(options.consequent) && hasPreviewPolicy(options.alternate);
  if (options.type === 'Identifier') return options.name !== 'undefined';
  return options.type === 'MemberExpression' || options.type === 'CallExpression';
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Make configuration migration preview policy explicit at each load.' },
  },
  create(context) {
    if (!inProductionSource(context) || isOneOf(context, ['src/config.ts'])) return {};
    return {
      CallExpression(node) {
        if (node.callee.type !== 'Identifier') return;
        const index = OPTIONS_INDEX.get(node.callee.name);
        if (index === undefined || hasPreviewPolicy(node.arguments[index])) return;
        context.report({ node, message: 'Pass explicit dryRun options to config loading so previews do not migrate files. Forward the command options, use { dryRun: true } for read-only paths, or disable this line with the reason this path must write.' });
      },
    };
  },
});
