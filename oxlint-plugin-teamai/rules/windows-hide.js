/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';
import { inProductionSource, stringLiteralValue } from '../utils.js';

const MODULES = new Set(['node:child_process', 'child_process']);
const LAUNCHERS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']);

/** @param {ESTree.Node | null | undefined} node */
const unwrapAwait = (node) => (node?.type === 'AwaitExpression' ? node.argument : node);

/** Whether `node` is `import('child_process')` or `require('child_process')`, awaited or not. */
function loadsChildProcess(/** @type {ESTree.Node | null | undefined} */ node) {
  const load = unwrapAwait(node);

  if (load?.type === 'ImportExpression') return MODULES.has(stringLiteralValue(load.source) ?? '');

  return load?.type === 'CallExpression' && load.callee.type === 'Identifier' && load.callee.name === 'require'
    && MODULES.has(stringLiteralValue(load.arguments[0]) ?? '');
}

/**
 * Whether `node` is `promisify(...)`.
 * @param {ESTree.Node} node
 * @returns {node is ESTree.CallExpression}
 */
function isPromisify(node) {
  return node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'promisify';
}

/** The property name of a non-computed key or member. */
function keyName(/** @type {ESTree.Node} */ key) {
  if (key.type === 'Identifier') return key.name;

  return stringLiteralValue(key);
}

/**
 * Whether `options` is an object literal that sets `windowsHide: true` itself,
 * with no spread, computed key or `windowsHide` after it that could set it back.
 */
function hidesWindow(/** @type {ESTree.Node} */ options) {
  if (options.type !== 'ObjectExpression') return false;

  const last = options.properties.findLast((property) => property.type === 'SpreadElement'
    || property.computed || keyName(property.key) === 'windowsHide');

  return last?.type === 'Property' && !last.computed && last.value.type === 'Literal' && last.value.value === true;
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Require windowsHide: true on every child_process launch in production source.' },
  },
  create(context) {
    if (!inProductionSource(context)) return {};
    /** Local names bound to a launcher, and to the module itself. */
    const launchers = new Set();
    const namespaces = new Set();
    /** @type {Array<[string, ESTree.Node]>} `const run = promisify(execFile)`: names whose value may wrap a launcher. */
    const promisified = [];
    /** @type {ESTree.CallExpression[]} */
    const calls = [];

    /** @type {(callee: ESTree.Node) => boolean} Whether `callee` names a launcher: `spawn`, `cp.spawn`, `promisify(execFile)`. */
    const isLauncher = (callee) => {
      if (callee.type === 'Identifier') return launchers.has(callee.name);

      if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier') {
        return namespaces.has(callee.object.name) && LAUNCHERS.has(keyName(callee.property) ?? '');
      }

      return isPromisify(callee) && callee.arguments[0] !== undefined && isLauncher(callee.arguments[0]);
    };

    return {
      ImportDeclaration(node) {
        if (!MODULES.has(String(node.source.value)) || node.importKind === 'type') return;

        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ImportSpecifier') namespaces.add(specifier.local.name);
          else if (specifier.importKind !== 'type' && LAUNCHERS.has(keyName(specifier.imported) ?? '')) launchers.add(specifier.local.name);
        }
      },
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && node.init && isPromisify(node.init)) promisified.push([node.id.name, node.init]);

        if (!loadsChildProcess(node.init)) return;

        if (node.id.type === 'Identifier') namespaces.add(node.id.name);
        else if (node.id.type === 'ObjectPattern') {
          for (const property of node.id.properties) {
            if (property.type === 'Property' && property.value.type === 'Identifier' && LAUNCHERS.has(keyName(property.key) ?? '')) launchers.add(property.value.name);
          }
        }
      },
      CallExpression(node) {
        calls.push(node);
      },
      'Program:exit'() {
        // Names are known only once the whole file is read: a launcher may be
        // imported below a function that calls it.
        for (const [name, init] of promisified) if (isLauncher(init)) launchers.add(name);

        for (const call of calls) {
          if (!isLauncher(call.callee) || call.arguments.slice(1).some(hidesWindow)) continue;
          context.report({
            node: call,
            message: 'Pass windowsHide: true in an object literal at this child_process call, so the process opens no console window on Windows. Options built elsewhere still need it written here, after any spread: { ...options, windowsHide: true }.',
          });
        }
      },
    };
  },
});
