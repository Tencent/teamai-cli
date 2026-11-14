import { defineRule } from '@oxlint/plugins';

import { inProductionSource } from '../utils.js';

/** The name every launch gives the OpenCode major version it builds an argv for. */
const MAJOR = 'opencodeMajor';

/**
 * The name `node`'s value is given to, through the expressions that pass a value on unchanged (a branch of `?:`, a side
 * of `??` or `||`, an `await`, a cast or `!`, a function's body or a `return` anywhere in it, in an `if`, a `try`, a
 * `catch` or a `switch` case); undefined when it is not given to a name.
 * @param {import('@oxlint/plugins').ESTree.Node} node
 * @returns {string | undefined}
 */
function receivingName(node) {
  let child = node;
  let parent = node.parent;

  while (parent) {
    switch (parent.type) {
      case 'ConditionalExpression':
      case 'IfStatement':
      case 'SwitchCase':
        if (parent.test === child) return undefined;
        break;
      case 'LogicalExpression':
      case 'AwaitExpression':
      case 'ParenthesizedExpression':
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
      case 'TSTypeAssertion':
      case 'ReturnStatement':
      case 'BlockStatement':
      case 'TryStatement':
      case 'CatchClause':
        break;
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        if (parent.body !== child) return undefined;
        break;
      case 'SwitchStatement':
        if (parent.discriminant === child) return undefined;
        break;
      case 'FunctionDeclaration':
        return parent.body === child && parent.id ? parent.id.name : undefined;
      case 'VariableDeclarator':
        return parent.init === child && parent.id.type === 'Identifier' ? parent.id.name : undefined;
      case 'AssignmentExpression':
        return parent.right !== child ? undefined
          : parent.left.type === 'Identifier' ? parent.left.name
            : parent.left.type === 'MemberExpression' && parent.left.property.type === 'Identifier' ? parent.left.property.name : undefined;
      case 'AssignmentPattern':
        return parent.right === child && parent.left.type === 'Identifier' ? parent.left.name : undefined;
      case 'Property':
      case 'PropertyDefinition':
      case 'MethodDefinition':
        return parent.value === child && !parent.computed && parent.key.type === 'Identifier' ? parent.key.name : undefined;
      default:
        return undefined;
    }

    child = parent;
    parent = parent.parent;
  }

  return undefined;
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Decide the OpenCode major version teamai assumes in one place, ASSUMED_OPENCODE_MAJOR.' },
  },
  create(context) {
    if (!inProductionSource(context)) return {};

    return {
      Literal(node) {
        if (!Number.isFinite(node.value) || receivingName(node) !== MAJOR) return;
        context.report({
          node,
          message: `An OpenCode major written as a number is a second answer to "which version does teamai assume". Ask the host's opencodeMajor, or use ASSUMED_OPENCODE_MAJOR from @teamai/tool-core/launch where the launch reads no version.`,
        });
      },
    };
  },
});
