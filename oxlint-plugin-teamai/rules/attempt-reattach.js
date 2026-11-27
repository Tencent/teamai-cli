/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { inProductionSource, isOneOf, lintedPath } from '../utils.js';

/** The attempt, whose `reattached` reads every reattach of its runtime. */
const OWNER = 'src/workflow/runtimes/attempt.ts';

/** The runtime made of parts, which reattaches each of its parts and says which no longer knows its share. */
const COMPOSER = 'src/workflow/runtimes/composed.ts';

/** The one function of the attempt that reattaches its runtime. */
const READER = 'reattached';

const MESSAGE = 'Read a reattach through the attempt\'s reattached(recorded, handle): a part of a composed runtime that answered gone proves nothing under an entry changed since the attempt ran, and a reattach read anywhere else takes the other part\'s alive for the whole place.';

/**
 * The name the function enclosing `node` is declared or bound with, as `function reattached() {…}` or
 * `const reattached = async () => …`; undefined outside a named function.
 * @param {ESTree.Node} node
 */
function enclosingFunctionName(node) {
  for (let /** @type {ESTree.Node | null} */ at = node.parent; at !== null; at = at.parent) {
    if (at.type === 'FunctionDeclaration') return at.id?.name;

    if ((at.type === 'FunctionExpression' || at.type === 'ArrowFunctionExpression') && at.parent?.type === 'VariableDeclarator' && at.parent.id.type === 'Identifier') return at.parent.id.name;
  }

  return undefined;
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Read a step runtime\'s reattach under src/workflow only through the attempt\'s reattached, which decides what a part that answered gone proves.' },
  },
  create(context) {
    if (!inProductionSource(context) || !lintedPath(context).includes('/src/workflow/') || isOneOf(context, [COMPOSER])) return {};
    const isOwner = isOneOf(context, [OWNER]);

    return {
      CallExpression(node) {
        const { callee } = node;

        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier' || callee.property.name !== 'reattach') return;

        if (isOwner && enclosingFunctionName(node) === READER) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
});
