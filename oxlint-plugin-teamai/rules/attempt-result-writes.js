/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { inProductionSource, isOneOf } from '../utils.js';

/** The one module that writes an attempt's result file, masked. */
const OWNER = 'src/workflow/attempt-result.ts';

/** Calls that write the file their first argument names. */
const WRITERS = new Set(['writeJsonAtomic', 'writeFileAtomic', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync']);

/**
 * The name a call is made by: `f` of `f()` and of `x.f()`.
 * @param {ESTree.Expression | ESTree.Super} callee
 * @returns {string | undefined}
 */
function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;

  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') return callee.property.name;

  return undefined;
}

/**
 * Whether `node` is a call of `attemptResultPath`.
 * @param {ESTree.Node | null | undefined} node
 */
function isResultPathCall(node) {
  return node?.type === 'CallExpression' && calleeName(node.callee) === 'attemptResultPath';
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Write an attempt\'s result file through AttemptResult.write, which masks the run\'s secrets first.' },
  },
  create(context) {
    if (!inProductionSource(context) || isOneOf(context, [OWNER])) return {};
    /** Names bound to `attemptResultPath(...)` in this file. */
    const bound = new Set();

    /**
     * Whether `target` names an attempt's result file: `attemptResultPath(...)`, a name bound to one, or a `resultPath`,
     * the field a tool launch carries it in.
     * @param {ESTree.Node | undefined} target
     */
    const namesResultFile = (target) => {
      if (isResultPathCall(target)) return true;

      if (target?.type === 'Identifier') return bound.has(target.name) || target.name === 'resultPath';

      return target?.type === 'MemberExpression' && !target.computed && target.property.type === 'Identifier' && target.property.name === 'resultPath';
    };

    return {
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && isResultPathCall(node.init)) bound.add(node.id.name);
      },
      CallExpression(node) {
        const name = calleeName(node.callee);

        if (name === undefined || !WRITERS.has(name) || !namesResultFile(node.arguments[0])) return;
        context.report({
          node,
          message: `Write an attempt's result file with AttemptResult.write(file, body, secrets) from ${OWNER}: it masks the run's secrets before the file reaches disk, and a bare ${name}( keeps any credential the body repeats.`,
        });
      },
    };
  },
});
