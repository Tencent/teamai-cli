/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';
import { repositoryPath, stringLiteralValue } from '../utils.js';

/** A git command whose output one pipe, not `||`, hands to the next command; a redirect such as `2>&1` stays in the command. */
const PIPED_GIT = /\bgit\s+(?:[^;&|\n]|>&)*\|(?!\|)/;

/**
 * The text of `node` when it is a string or template literal, an interpolation read as one word; undefined otherwise.
 * @param {ESTree.Node} node
 * @returns {string | undefined}
 */
function literalText(node) {
  if (node.type === 'TemplateLiteral') return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('x');

  return stringLiteralValue(node);
}

/**
 * Reports `node` when its text pipes a git command.
 * @param {import('@oxlint/plugins').Context} context
 * @param {ESTree.Node} node
 */
function check(context, node) {
  const text = literalText(node);

  // A line that starts with a pipe is a Markdown table row, whose cells may name a git command.
  if (text === undefined || !text.split('\n').some((line) => !/^\s*\|/.test(line) && PIPED_GIT.test(line))) return;
  context.report({
    node,
    message: 'This script pipes a git command into the next one, and a pipe exits with its last command, so a git that fails reads as an empty answer: '
      + 'a hook that was to refuse a push lets it through. Capture the output first and exit when the git fails, as in subjects=$(git log …) || exit 1.',
  });
}

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Capture a git command\'s output in a shell script before testing it, so a git that fails is not read as an empty answer.' } },
  create(context) {
    // A rule's fixtures are source text it reads, not scripts anything runs.
    if (repositoryPath(context).relative.startsWith('oxlint-plugin-teamai/')) return {};

    return {
      Literal(node) { check(context, node); },
      TemplateLiteral(node) { check(context, node); },
    };
  },
});
