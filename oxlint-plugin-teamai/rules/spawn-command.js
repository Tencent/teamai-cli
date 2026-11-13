/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { namesExport } from '../imports.js';
import { inProductionSource, isOneOf, scopedFiles, stringLiteralValue, variableOf } from '../utils.js';

/** The one module that starts a process through cross-spawn, behind `spawnCommand`, `spawnCommandSync` and `execCommand`. */
const OWNER = scopedFiles(['packages/shared/src/exec.ts']);

const MESSAGE = 'Start a process with spawnCommand or spawnCommandSync from @teamai/shared/exec, not cross-spawn: on Windows they run an npm .cmd shim under the system cmd.exe with its arguments escaped twice, and refuse arguments cmd.exe cannot carry, where cross-spawn escapes a shim outside node_modules/.bin once.';

/** The modules `createRequire` comes from. */
const MODULE = new Set(['module', 'node:module']);

/**
 * Whether `node` is `createRequire`, as node:module's export or a name it was imported as.
 * @param {import('@oxlint/plugins').Context['sourceCode']} sourceCode
 * @param {ESTree.Node} node
 */
function isCreateRequire(sourceCode, node) {
  // A name no import binds is judged by its spelling.
  return namesExport(sourceCode, node, { modules: MODULE, name: 'createRequire' }) ?? (node.type === 'Identifier' && node.name === 'createRequire');
}

/**
 * Whether calling `callee` loads a module: `require`, a `createRequire(…)` call, or a name bound to either.
 * @param {import('@oxlint/plugins').Context['sourceCode']} sourceCode
 * @param {ESTree.Node} callee
 */
function isRequire(sourceCode, callee) {
  if (callee.type === 'CallExpression') return isCreateRequire(sourceCode, callee.callee);

  if (callee.type !== 'Identifier') return false;
  const def = variableOf(sourceCode, callee, callee.name)?.defs[0];

  if (def === undefined) return callee.name === 'require';

  if (def.type !== 'Variable' || def.node.type !== 'VariableDeclarator' || !def.node.init) return false;
  const { init } = def.node;

  return (init.type === 'Identifier' && init.name === 'require') || (init.type === 'CallExpression' && isCreateRequire(sourceCode, init.callee));
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Launch through spawnCommand, the one Windows launch path, rather than cross-spawn.' },
  },
  create(context) {
    if (!inProductionSource(context) || isOneOf(context, OWNER)) return {};

    return {
      ImportDeclaration(node) {
        if (node.source.value === 'cross-spawn') context.report({ node, message: MESSAGE });
      },
      ExportNamedDeclaration(node) {
        if (node.source?.value === 'cross-spawn') context.report({ node, message: MESSAGE });
      },
      ExportAllDeclaration(node) {
        if (node.source.value === 'cross-spawn') context.report({ node, message: MESSAGE });
      },
      ImportExpression(node) {
        if (stringLiteralValue(node.source) === 'cross-spawn') context.report({ node, message: MESSAGE });
      },
      CallExpression(node) {
        if (stringLiteralValue(node.arguments[0]) === 'cross-spawn' && isRequire(context.sourceCode, node.callee)) context.report({ node, message: MESSAGE });
      },
    };
  },
});
