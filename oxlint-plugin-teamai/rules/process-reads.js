/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { inProductionSource, stringLiteralValue } from '../utils.js';

const MESSAGE = 'This reads a process from /proc, which Linux answers from /proc where macOS runs ps, and the agent wait budget runs on Linux, so CI would not see the wait macOS has. Tell the read with tellProcessRead from @teamai/shared/process-group, as the ps macOS runs for it, or read it through process-group.';

/** The one call that tells a process read, which a module reading `/proc` makes. */
const TELL = 'tellProcessRead';

/**
 * Whether `text`, where `node` stands, names a path under `/proc`: any text that starts with `/proc/`, and `/proc`
 * itself where a path is built or opened from it, as an argument or the start of a sum. A bare `/proc` elsewhere, as
 * the mount a sandbox's argument list names, reads nothing.
 * @param {string} text
 * @param {ESTree.Node} node
 */
function namesProcPath(text, node) {
  if (text.startsWith('/proc/')) return true;

  return text === '/proc' && opensFrom(node);
}

/**
 * Whether a path is built or opened from `node`: it is an argument, the start of a sum, or the head of a template
 * that goes on with a path below it.
 * @param {ESTree.Node} node
 */
function opensFrom(node) {
  const { parent } = node;

  if (parent?.type === 'TemplateLiteral') return parent.expressions[0] === node && parent.quasis[0]?.value.cooked === '' && (parent.quasis[1]?.value.cooked ?? '').startsWith('/');

  return ((parent?.type === 'CallExpression' || parent?.type === 'NewExpression') && parent.arguments.some((argument) => argument === node)) || (parent?.type === 'BinaryExpression' && parent.operator === '+' && parent.left === node);
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'A module that reads a process from /proc tells the read, so the agent wait budget counts it on Linux.' },
  },
  create(context) {
    if (!inProductionSource(context)) return {};
    /** @type {ESTree.Node[]} */
    const reads = [];
    /** The names a bare `/proc` is first stored in, and each use of a name a path is built or opened from. */
    const procNames = new Set();
    /** @type {ESTree.IdentifierReference[]} */
    const opened = [];
    let isTelling = false;

    return {
      /** @param {ESTree.BooleanLiteral | ESTree.NullLiteral | ESTree.NumericLiteral | ESTree.StringLiteral | ESTree.BigIntLiteral | ESTree.RegExpLiteral} node */
      Literal(node) {
        const text = stringLiteralValue(node);

        if (text !== undefined && namesProcPath(text, node)) reads.push(node);

        if (text === '/proc' && node.parent?.type === 'VariableDeclarator' && node.parent.id.type === 'Identifier') procNames.add(node.parent.id.name);
      },
      /** @param {ESTree.IdentifierReference} node */
      Identifier(node) {
        if (opensFrom(node)) opened.push(node);
      },
      /** @param {ESTree.TemplateLiteral} node */
      TemplateLiteral(node) {
        const head = node.quasis[0]?.value.cooked ?? '';

        if (head.startsWith('/proc/') || (head === '/proc' && node.expressions.length > 0)) reads.push(node);
      },
      /** @param {ESTree.CallExpression} node */
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === TELL) isTelling = true;
      },
      'Program:exit'() {
        if (isTelling) return;

        for (const node of [...reads, ...opened.filter(({ name }) => procNames.has(name))]) context.report({ node, message: MESSAGE });
      },
    };
  },
});
