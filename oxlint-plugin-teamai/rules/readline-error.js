/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { importedName } from '../imports.js';
import { stringLiteralValue, variableOf } from '../utils.js';

/** The methods that add a listener to an emitter. */
const LISTENS = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']);

const MESSAGE = 'Listen for errors on this interface: readline re-emits its input\'s errors on the interface, which throws them when nothing listens there, so a socket or stream that fails ends the process. Add .on(\'error\', …) to it, or read it with for await, which rejects instead.';

/**
 * The `input` `createInterface` reads: its options object's `input`, or its first argument itself, as the positional
 * form passes the stream, or an options object the rule cannot see into, which it checks all the same.
 * @param {ESTree.Node | undefined} first
 */
function inputOf(first) {
  if (first === undefined || first.type === 'SpreadElement') return undefined;

  if (first.type !== 'ObjectExpression') return first;
  const input = first.properties.find((candidate) => candidate.type === 'Property' && !candidate.computed && candidate.key.type === 'Identifier' && candidate.key.name === 'input');

  return input?.type === 'Property' ? input.value : undefined;
}

/**
 * Whether `node` is `process.stdin`: a terminal's input, whose error ends the command as it should.
 * @param {ESTree.Node} node
 */
function isProcessInput(node) {
  return node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && node.object.name === 'process' && node.property.type === 'Identifier' && node.property.name === 'stdin';
}

/** The modules readline's interface comes from. */
const READLINE = new Set(['readline', 'node:readline', 'readline/promises', 'node:readline/promises']);

/**
 * The name `variable` imports from readline: `createInterface` or `Interface` for a named import, `*` for the module
 * itself, as a default or namespace import gives it; undefined when it is no import of readline.
 * @param {import('@oxlint/plugins').Variable | undefined} variable
 */
function readlineImport(variable) {
  const def = variable?.defs[0];

  if (def?.type !== 'ImportBinding' || def.parent?.type !== 'ImportDeclaration' || !READLINE.has(String(def.parent.source.value))) return undefined;
  const { node } = def;

  if (node.type !== 'ImportSpecifier') return '*';

  return importedName(node);
}

/**
 * Whether `node` makes a readline interface: `createInterface` as readline's export, a name it was imported as, or
 * `new Interface`. A `createInterface` the file does not import from readline counts too, so a wrapper of it is checked.
 * @param {import('@oxlint/plugins').Context['sourceCode']} sourceCode
 * @param {ESTree.CallExpression | ESTree.NewExpression} node
 */
function makesInterface(sourceCode, node) {
  const { callee } = node;
  const wanted = node.type === 'NewExpression' ? 'Interface' : 'createInterface';

  if (callee.type === 'Identifier') return (node.type === 'CallExpression' && callee.name === wanted) || readlineImport(variableOf(sourceCode, callee, callee.name)) === wanted;

  if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier' || callee.property.name !== wanted) return false;

  return node.type === 'CallExpression' || (callee.object.type === 'Identifier' && readlineImport(variableOf(sourceCode, callee.object, callee.object.name)) === '*');
}

/**
 * Whether the member `node` is `[Symbol.asyncIterator]`.
 * @param {ESTree.MemberExpression} node
 */
function isAsyncIterator(node) {
  const key = node.property;

  return node.computed && key.type === 'MemberExpression' && key.object.type === 'Identifier' && key.object.name === 'Symbol' && key.property.type === 'Identifier' && key.property.name === 'asyncIterator';
}

/**
 * Whether `call` adds an `error` listener to its callee's object.
 * @param {ESTree.CallExpression} call
 */
function listensForErrors(call) {
  const { callee } = call;

  return callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && LISTENS.has(callee.property.name) && stringLiteralValue(call.arguments[0]) === 'error';
}

/**
 * Whether what reads `node`, an interface, handles its errors: an error listener on the chain of calls it starts, its
 * async iterator, or `for await` over it.
 * @param {ESTree.Node} node
 */
function isHandledWhereMade(node) {
  /** @type {ESTree.Node} */
  let current = node;

  for (;;) {
    const { parent } = current;

    if (parent?.type === 'ForOfStatement' && parent.await && parent.right === current) return true;

    if (parent?.type !== 'MemberExpression' || parent.object !== current) return false;

    if (isAsyncIterator(parent)) return true;
    const call = parent.parent;

    if (call?.type !== 'CallExpression' || call.callee !== parent) return false;

    if (listensForErrors(call)) return true;
    current = call;
  }
}

/**
 * The variable the interface `node` is bound to, as `const lines = createInterface(…)` or `lines = createInterface(…)`,
 * and where that write is; undefined when it is bound to none.
 * @param {import('@oxlint/plugins').Context['sourceCode']} sourceCode
 * @param {ESTree.Node} node
 */
function boundVariable(sourceCode, node) {
  const { parent } = node;

  if (parent?.type === 'VariableDeclarator' && parent.init === node && parent.id.type === 'Identifier') {
    const [variable] = sourceCode.getDeclaredVariables(parent);

    return variable && { variable, at: parent.id.range[0] };
  }

  if (parent?.type === 'AssignmentExpression' && parent.right === node && parent.left.type === 'Identifier') {
    const variable = variableOf(sourceCode, parent.left, parent.left.name);

    return variable && { variable, at: parent.left.range[0] };
  }

  return undefined;
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Listen for errors on every readline interface over a socket or stream: readline re-emits its input\'s errors there and throws them when nothing listens.' },
  },
  create(context) {
    const { sourceCode } = context;

    /**
     * Whether the interface made at `node` handles its errors: where it is made, or, bound to a variable, through a read
     * of that variable before the next interface it takes.
     * @param {ESTree.CallExpression | ESTree.NewExpression} node
     */
    const isHandled = (node) => {
      if (isHandledWhereMade(node)) return true;
      const bound = boundVariable(sourceCode, node);

      if (!bound) return false;
      const writes = bound.variable.references.filter((reference) => reference.isWrite()).map((reference) => reference.identifier.range[0]);
      const until = Math.min(...writes.filter((at) => at > bound.at), Number.POSITIVE_INFINITY);

      return bound.variable.references.some(({ identifier }) => identifier.range[0] > bound.at && identifier.range[0] < until && isHandledWhereMade(identifier));
    };

    /** @param {ESTree.CallExpression | ESTree.NewExpression} node */
    const check = (node) => {
      if (!makesInterface(sourceCode, node)) return;
      const input = inputOf(node.arguments[0]);

      if (input === undefined || isProcessInput(input) || isHandled(node)) return;
      context.report({ node, message: MESSAGE });
    };

    return { CallExpression: check, NewExpression: check };
  },
});
