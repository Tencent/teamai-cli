/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { inProductionSource } from '../utils.js';

/** The factory of the git that runs in a checkout a step controlled. */
const UNTRUSTED = 'untrustedGit';

/**
 * The name a call is made by, through any `await`: `f` of `f()`, of `await f()` and of `ns.f()`.
 * @param {ESTree.Node | null | undefined} node
 * @returns {string | undefined}
 */
function calledName(node) {
  const call = node?.type === 'AwaitExpression' ? node.argument : node;

  if (call?.type !== 'CallExpression') return undefined;

  if (call.callee.type === 'Identifier') return call.callee.name;

  return call.callee.type === 'MemberExpression' && call.callee.property.type === 'Identifier' ? call.callee.property.name : undefined;
}

/**
 * Whether `node` is the host `git` itself: `git`, or `ns.git` of a namespace import.
 * @param {ESTree.Node} node
 */
function isHostGit(node) {
  if (node.type === 'Identifier') return node.name === 'git';

  return node.type === 'MemberExpression' && node.property.type === 'Identifier' && node.property.name === 'git';
}

/**
 * What a return may give that is a git, through either branch of a conditional or logical expression: the name of each
 * call, and `git` for the host git itself. Any other value, such as a failure the caller checks for, gives none.
 * @param {ESTree.Node | null | undefined} node
 * @returns {string[]}
 */
function returnedGits(node) {
  if (!node) return [];

  if (node.type === 'ConditionalExpression') return [...returnedGits(node.consequent), ...returnedGits(node.alternate)];

  if (node.type === 'LogicalExpression') return [...returnedGits(node.left), ...returnedGits(node.right)];

  if (isHostGit(node)) return ['git'];
  const called = calledName(node);

  return called === undefined ? [] : [called];
}

/**
 * The names a parameter binds: `a` of `a`, `a = 1`, `...a`, and each name a destructuring pattern binds.
 * @param {ESTree.Node | null | undefined} node
 * @returns {string[]}
 */
function boundNames(node) {
  switch (node?.type) {
    case 'Identifier': return [node.name];
    case 'AssignmentPattern': return boundNames(node.left);
    case 'RestElement': return boundNames(node.argument);
    case 'ArrayPattern': return node.elements.flatMap(boundNames);
    case 'ObjectPattern': return node.properties.flatMap((property) => boundNames(property.type === 'RestElement' ? property : property.value));
    case 'TSParameterProperty': return boundNames(node.parameter);
    default: return [];
  }
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Commit a step\'s work with untrustedGit, so nothing the step planted in the checkout\'s config runs on the host.' },
  },
  create(context) {
    if (!inProductionSource(context)) return {};
    /**
     * The scopes being walked, innermost last: the file, each function (with its name, null when anonymous) and each
     * block. Each binds names to every call assigned to them, `undefined` for a value that is no call, such as a
     * parameter.
     * @typedef {{ fn: boolean; name: string | null; bindings: Map<string, Array<string | undefined>> }} Scope
     * @type {Scope[]}
     */
    const scopes = [{ fn: true, name: null, bindings: new Map() }];
    /** By function name, whether every git a function of this file with that name returns is an `untrustedGit(...)`. */
    const factories = new Map();
    /** The local names `commitWork` is imported under. */
    const commitNames = new Set(['commitWork']);
    /**
     * The `commitWork(...)` calls of this file, each with the scopes it is inside of.
     * @type {Array<{ node: ESTree.CallExpression; scopes: Scope[] }>}
     */
    const commits = [];

    /** @param {ESTree.Function | ESTree.ArrowFunctionExpression} node */
    const enterFunction = (node) => {
      const bindings = new Map(node.params.flatMap(boundNames).map((name) => [name, [undefined]]));

      scopes.push({ fn: true, name: node.type === 'FunctionDeclaration' && node.id ? node.id.name : null, bindings });
    };

    const enterBlock = () => {
      scopes.push({ fn: false, name: null, bindings: new Map() });
    };

    const exit = () => {
      scopes.pop();
    };

    /**
     * Whether `called` is untrustedGit or a function of this file every return of which is one.
     * @param {string | undefined} called
     */
    const makesUntrusted = (called) => called === UNTRUSTED || (called !== undefined && factories.get(called) === true);

    return {
      FunctionDeclaration: enterFunction,
      'FunctionDeclaration:exit': exit,
      FunctionExpression: enterFunction,
      'FunctionExpression:exit': exit,
      ArrowFunctionExpression: enterFunction,
      'ArrowFunctionExpression:exit': exit,
      BlockStatement: enterBlock,
      'BlockStatement:exit': exit,
      ImportSpecifier(node) {
        if (node.imported.type === 'Identifier' && node.imported.name === 'commitWork') commitNames.add(node.local.name);
      },
      ReturnStatement(node) {
        const owner = scopes.findLast(({ fn }) => fn)?.name;

        const gits = returnedGits(node.argument);

        if (owner && gits.length > 0) factories.set(owner, factories.get(owner) !== false && gits.every((called) => called === UNTRUSTED));
      },
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier') scopes.at(-1)?.bindings.set(node.id.name, [calledName(node.init)]);
      },
      AssignmentExpression(node) {
        if (node.left.type !== 'Identifier') return;
        const { name } = node.left;

        scopes.findLast(({ bindings }) => bindings.has(name))?.bindings.get(name)?.push(calledName(node.right));
      },
      CallExpression(node) {
        const { callee } = node;

        const isCommit = callee.type === 'Identifier' ? commitNames.has(callee.name)
          : callee.type === 'MemberExpression' && callee.property.type === 'Identifier' && callee.property.name === 'commitWork';

        if (isCommit) commits.push({ node, scopes: [...scopes] });
      },
      'Program:exit'() {
        for (const { node, scopes: around } of commits) {
          const runGit = node.arguments[3];
          const name = runGit?.type === 'Identifier' ? runGit.name : undefined;
          const assigned = name === undefined ? [calledName(runGit)] : around.findLast(({ bindings }) => bindings.has(name))?.bindings.get(name) ?? [undefined];

          if (assigned.every(makesUntrusted)) continue;
          context.report({
            node,
            message: 'Pass commitWork( the git of untrustedGit(env), or a name bound to it: a step ran in that checkout, and the git commitWork defaults to, or any other, runs the hooks and fsmonitor the step may have planted in its config on the host.',
          });
        }
      },
    };
  },
});
