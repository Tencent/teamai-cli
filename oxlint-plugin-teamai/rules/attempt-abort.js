/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { inProductionSource, isOneOf, lintedPath, stringLiteralValue, variableOf } from '../utils.js';

/** The module that owns the step's abort signal: `AttemptRun.open` and `setup` follow it. */
const OWNER = 'src/workflow/runtimes/attempt.ts';

/** The methods that stop an attempt, or whatever a handler passes the abort on to. */
const STOPS = new Set(['cancel', 'stop']);

const MESSAGE = 'Pass the step\'s signal to the attempt instead of listening for its abort here: AttemptRun.open(view, { signal }) and AttemptRun.setup(request, events, { signal }) cancel the attempt on that abort in whatever phase it is in, and a listener added by its caller misses each phase before it, such as an open whose place is never ready.';

/**
 * Whether `node` is a function: a declaration, an expression or an arrow.
 * @param {ESTree.Node} node
 */
function isFunction(node) {
  return node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
}

/**
 * The function an abort listener runs: the argument itself, or the function a name in scope is bound to, as
 * `const stop = () => …` or `function stop() {…}`; undefined for anything lint cannot follow.
 * @param {import('@oxlint/plugins').Context['sourceCode']} sourceCode
 * @param {ESTree.Node | undefined} handler
 */
function handlerFunction(sourceCode, handler) {
  if (handler === undefined) return undefined;

  if (isFunction(handler)) return handler;

  if (handler.type !== 'Identifier') return undefined;
  const def = variableOf(sourceCode, handler, handler.name)?.defs[0];

  if (def?.type === 'FunctionName') return def.node;

  if (def?.type === 'Variable' && def.node.type === 'VariableDeclarator' && def.node.init && isFunction(def.node.init)) return def.node.init;

  return undefined;
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Let the attempt own the step\'s abort signal: no listener of a caller under src/workflow cancels or stops an attempt on abort.' },
  },
  create(context) {
    if (!inProductionSource(context) || !lintedPath(context).includes('/src/workflow/') || isOneOf(context, [OWNER])) return {};
    const { sourceCode } = context;
    /** @type {Set<ESTree.Node>} Every function that encloses a call of `.cancel()` or `.stop()`. */
    const stopping = new Set();
    /** @type {Array<{ node: ESTree.CallExpression; handler: ESTree.Node }>} */
    const listeners = [];

    return {
      CallExpression(node) {
        const { callee } = node;

        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return;

        if (callee.property.name === 'addEventListener' && stringLiteralValue(node.arguments[0]) === 'abort') {
          const handler = handlerFunction(sourceCode, node.arguments[1]);

          if (handler) listeners.push({ node, handler });

          return;
        }

        if (!STOPS.has(callee.property.name)) return;

        for (let /** @type {ESTree.Node | null} */ at = node.parent; at !== null; at = at.parent) if (isFunction(at)) stopping.add(at);
      },
      'Program:exit'() {
        for (const { node, handler } of listeners) if (stopping.has(handler)) context.report({ node, message: MESSAGE });
      },
    };
  },
});
