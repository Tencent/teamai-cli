/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';
import { isTestSupportPath, repositoryPath, scopedFiles, stringLiteralValue } from '../utils.js';

/**
 * Where a worktree is removed, or git's record of a gone one forgotten: `git worktree remove --force` deletes every
 * worktree inside the one it removes, uncommitted work and all, such as the worktree of a run started inside it, and
 * `removeWorktree` refuses that. Each entry is a file and the functions in it that may call git's removal.
 */
export const ALLOWED = [
  { file: 'src/workflow/worktree.ts', functions: ['removeWorktree', 'forgetGoneWorktrees'], reason: 'the owner' },
  // Upstream's own calls, which remove worktrees nothing nests a worktree in.
  { file: 'scripts/agent-wait-budget.ts', functions: ['measureAgentWait'], reason: 'removes the worktrees the measure made in its verify world' },
  { file: 'src/uninstall.ts', functions: ['unregisterWorktreesIn'], reason: 'the side-branch worktrees in ~/.teamai, which uninstall deletes whole' },
  { file: 'src/utils/branch-worktree.ts', functions: ['openWorktree', 'removeOldCheckouts', 'retireWhileLockedImpl'], reason: 'the data home\'s side-branch worktree, which git removes only when clean' },
  { file: 'src/utils/reports-branch.ts', functions: ['withKnowledgeWorktree'], reason: 'a temporary worktree of the team repo it made for one write' },
  { file: 'src/workflow/place/data.ts', functions: ['removeDataCheckout'], reason: 'forgets the record of a data checkout it deleted, in the run\'s own directory' },
  { file: 'src/workflow/place/team.ts', functions: ['rejectedTeamFiles'], reason: 'a detached worktree of the base inside .git, made and removed in one call' },
];

scopedFiles(ALLOWED.map(({ file }) => file));

const MESSAGE = 'Remove a worktree with removeWorktree, and forget the record of a gone one with forgetGoneWorktrees, from src/workflow/worktree.ts: '
  + 'git worktree remove --force deletes every worktree inside the one it removes, uncommitted work and all, and removeWorktree refuses that. '
  + 'Upstream\'s own calls are listed in oxlint-plugin-teamai/rules/worktree-removal.js with why.';

/**
 * Whether `file`, from the repository root, is in the rule's scope: every file but tests and test support.
 * @param {string} file
 * @returns {boolean}
 */
export function inScope(file) {
  return !/\.test\.[cm]?[jt]sx?$/.test(file) && !/(^|\/)__tests__\//.test(file) && !isTestSupportPath(file) && !file.startsWith('oxlint-plugin-teamai/test/');
}

/**
 * The text of `node` when it is a string literal or a template literal with no expression.
 * @param {ESTree.Node | null | undefined} node
 * @returns {string | undefined}
 */
function literal(node) {
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? undefined;

  return stringLiteralValue(node);
}

/**
 * Whether `nodes`, git's arguments, hold `worktree` followed by `remove` or `prune`.
 * @param {ReadonlyArray<ESTree.Node | null>} nodes
 * @returns {boolean}
 */
function removesWorktree(nodes) {
  const args = nodes.map(literal);

  return args.some((arg, at) => arg === 'worktree' && (args[at + 1] === 'remove' || args[at + 1] === 'prune'));
}

/**
 * The name of the nearest named function around `node`: a declaration's, or the variable, property or method it is
 * assigned to.
 * @param {ESTree.Node} node
 * @returns {string | undefined}
 */
function enclosingFunction(node) {
  for (let at = node.parent; at; at = at.parent) {
    if (at.type !== 'FunctionDeclaration' && at.type !== 'FunctionExpression' && at.type !== 'ArrowFunctionExpression') continue;

    if (at.type !== 'ArrowFunctionExpression' && at.id) return at.id.name;
    const holder = at.parent;

    if (holder?.type === 'VariableDeclarator' && holder.id.type === 'Identifier') return holder.id.name;

    if ((holder?.type === 'Property' || holder?.type === 'MethodDefinition') && holder.key.type === 'Identifier') return holder.key.name;
  }

  return undefined;
}

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Remove a worktree, or forget a gone one, only through the owner in src/workflow/worktree.ts.' } },
  create(context) {
    const { relative } = repositoryPath(context);

    if (!inScope(relative)) return {};
    const allowed = ALLOWED.find(({ file }) => file === relative)?.functions ?? [];
    /** @type {Set<string>} The allowed functions seen removing a worktree. */
    const used = new Set();

    /**
     * Reports `node` when `args`, git's arguments, remove a worktree outside the functions this file is let.
     * @param {ESTree.Node} node
     * @param {ReadonlyArray<ESTree.Node | null>} args
     */
    const check = (node, args) => {
      if (!removesWorktree(args)) return;
      const name = enclosingFunction(node);

      if (name !== undefined && allowed.includes(name)) used.add(name);
      else context.report({ node, message: MESSAGE });
    };

    return {
      ArrayExpression(node) {
        check(node, node.elements);
      },
      CallExpression(node) {
        check(node, node.arguments);
      },
      'Program:exit'(node) {
        for (const name of allowed.filter((listed) => !used.has(listed))) {
          context.report({ node, message: `oxlint-plugin-teamai/rules/worktree-removal.js lets ${name} in ${relative} remove worktrees, and ${name} there no longer removes one: point the entry at the function that does, or remove it.` });
        }
      },
    };
  },
});
