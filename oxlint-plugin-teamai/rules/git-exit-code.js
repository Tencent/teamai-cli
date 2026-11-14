/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';
import { inProductionSource, stringLiteralValue } from '../utils.js';

/**
 * Git commands that answer only with their exit code, printing nothing either way: the subcommand, and the flags any of
 * which makes it one.
 */
const EXIT_CODE_ANSWERS = new Map([
  ['merge-base', ['--is-ancestor']],
  ['cat-file', ['-e']],
  ['diff', ['--quiet', '--exit-code']],
  ['diff-index', ['--quiet', '--exit-code']],
  ['diff-files', ['--quiet', '--exit-code']],
  ['diff-tree', ['--quiet', '--exit-code']],
  ['show-ref', ['--quiet', '-q', '--exists']],
  ['check-ignore', ['--quiet', '-q']],
]);

/**
 * Git commands that print their answer on a yes and answer a no with their exit code alone when quiet: the subcommand,
 * and the flags any of which makes it quiet. simple-git raw reads them by their output, which is right; a git that
 * returns the exit code needs gitAnswer, or a git that did not start reads as a missing ref or a detached HEAD.
 */
const QUIET_ANSWERS = new Map([
  ['rev-parse', ['--quiet', '-q']],
  ['symbolic-ref', ['--quiet', '-q']],
]);

/** Global options that take the next argument as their value. */
const GLOBAL_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env']);

/**
 * The literal text of each argument of `node`, an array expression; undefined for an argument that is not literal.
 * @param {ESTree.Node | undefined} node
 * @returns {Array<string | undefined>}
 */
function literalArgs(node) {
  if (node?.type !== 'ArrayExpression') return [];

  return node.elements.map((element) => {
    if (element?.type === 'TemplateLiteral' && element.expressions.length === 0) return element.quasis[0]?.value.cooked ?? undefined;

    return stringLiteralValue(element);
  });
}

/**
 * The exit-code question `node`, an array of git arguments, asks: its subcommand, when it is one; undefined otherwise.
 * @param {ESTree.Node | undefined} node
 * @param {Map<string, string[]>} [questions]
 * @returns {string | undefined}
 */
function exitCodeQuestion(node, questions = EXIT_CODE_ANSWERS) {
  const args = literalArgs(node);
  const spread = node?.type === 'ArrayExpression' ? node.elements.map((element) => element?.type === 'SpreadElement') : [];
  let at = 0;

  // Global options and spread config come before the subcommand: `-c <value>`, `-C <dir>`, or any other `-` flag.
  while (at < args.length && (spread[at] || args[at]?.startsWith('-'))) at += GLOBAL_WITH_VALUE.has(args[at] ?? '') ? 2 : 1;
  const [command, ...rest] = args.slice(at);
  const flags = command === undefined ? undefined : questions.get(command);

  return flags && rest.some((arg) => arg !== undefined && flags.includes(arg)) ? command : undefined;
}

/** Every question git answers with its exit code alone, quiet ones included. */
const ALL_QUESTIONS = new Map([...EXIT_CODE_ANSWERS, ...QUIET_ANSWERS]);

/** The helper that reads an exit-code answer, telling a no from a git that never ran. */
const ANSWER_READER = 'gitAnswer';

/**
 * Whether `node` is the answer reader itself.
 * @param {ESTree.Node | undefined} node
 */
function isAnswerReader(node) {
  return node?.type === 'Identifier' && node.name === ANSWER_READER;
}

/**
 * Whether `node`, a call, is read through `gitAnswer(...)`, awaited or not, or through `.then(gitAnswer, ...)`.
 * @param {ESTree.CallExpression} node
 */
function readAsAnswer(node) {
  const value = node.parent?.type === 'AwaitExpression' ? node.parent : node;
  const reader = value.parent;

  if (reader?.type === 'CallExpression' && isAnswerReader(reader.callee) && reader.arguments[0] === value) return true;
  const then = node.parent;

  return then?.type === 'MemberExpression' && then.object === node && then.property.type === 'Identifier' && then.property.name === 'then'
    && then.parent?.type === 'CallExpression' && then.parent.callee === then && isAnswerReader(then.parent.arguments[0]);
}

/**
 * Whether `node`, a call, is read only by whether it settled: awaited or run as a statement whose value is dropped, or
 * followed by a `then` whose first callback takes no value.
 * @param {ESTree.CallExpression} node
 */
function readBySettling(node) {
  const value = node.parent?.type === 'AwaitExpression' ? node.parent : node;

  if (value.parent?.type === 'ExpressionStatement') return true;
  const then = node.parent;

  if (then?.type !== 'MemberExpression' || then.object !== node || then.property.type !== 'Identifier' || then.property.name !== 'then') return false;
  const call = then.parent;
  const onValue = call?.type === 'CallExpression' && call.callee === then ? call.arguments[0] : undefined;

  return (onValue?.type === 'ArrowFunctionExpression' || onValue?.type === 'FunctionExpression') && onValue.params.length === 0;
}

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Ask git questions answered by the exit code through a git that returns it, and read the answer through gitAnswer.' } },
  create(context) {
    if (!inProductionSource(context)) return {};

    return {
      CallExpression(node) {
        const isRaw = node.callee.type === 'MemberExpression' && node.callee.property.type === 'Identifier' && node.callee.property.name === 'raw';

        if (isRaw) {
          const quiet = exitCodeQuestion(node.arguments[0], QUIET_ANSWERS);

          if (quiet !== undefined && readBySettling(node)) {
            context.report({
              node,
              message: `git ${quiet} answers a no with its exit code alone when quiet, and simple-git raw resolves on that exit with nothing on stderr, so whether it settled is always yes. `
                + 'Read what it printed, or ask through git() from src/workflow/worktree.ts and read the result through gitAnswer().',
            });

            return;
          }

          const command = exitCodeQuestion(node.arguments[0]);

          if (command === undefined) return;
          context.report({
            node,
            message: `git ${command} answers with its exit code alone, and simple-git raw resolves on a non-zero exit with nothing on stderr, so this check always passes. Use git() from src/workflow/worktree.ts, which returns the exit code.`,
          });

          return;
        }

        const command = node.arguments.map((argument) => exitCodeQuestion(argument, ALL_QUESTIONS)).find((asked) => asked !== undefined);

        if (command === undefined || readAsAnswer(node)) return;
        context.report({
          node,
          message: `git ${command} answers with its exit code alone, and a git that did not start answers nothing, which a bare exit-code check reads as a no. `
            + `Read the result through ${ANSWER_READER}() from src/workflow/worktree.ts, and handle its 'nothing'.`,
        });
      },
    };
  },
});
