/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { fsFunctionOf, isCalled, refersToValue } from '../fs-calls.js';
import { repositoryPath, scopedFiles, stringLiteralValue } from '../utils.js';

/** The calls that list a folder, and with `recursive` every folder under it. */
const LISTS = new Set(['readdir', 'readdirSync', 'opendir', 'opendirSync']);

const MESSAGE = 'List a folder and what is under it with entriesUnder from @teamai/shared/entries-under, not readdir or opendir with recursive: true, which enters a link to a folder (on Node 26 every form of it does): a link out of the folder lists what is outside it, and two links to a parent never end. entriesUnder lists a link and does not enter it.';

const UNREAD_MESSAGE = 'Give readdir or opendir its options as an object literal with no spread, or none, in a call of it where it stands, so lint can see whether it lists recursively: a recursive listing enters a link to a folder, so list a folder and what is under it with entriesUnder from @teamai/shared/entries-under.';

/**
 * Files that still list a folder recursively, or may (with options lint cannot read), each with how many such calls it has. A new call goes through
 * entriesUnder instead, in these files too: a count only falls, and a file that has fewer calls than its count fails
 * until the count is lowered.
 * @type {ReadonlyMap<string, number>}
 */
export const NOT_YET_MOVED = new Map(Object.entries({
  // Upstream's own listings, in files this repository shares with upstream, left as upstream has them so a sync merges
  // cleanly. The fix proposed upstream, "fix: recursive listings follow links out of the folder they list, and two links
  // to a parent never end", moves those of src/recall.ts and src/session-flow/sync.ts to a walk that follows no link.
  'scripts/check-docs.test.ts': 1,
  'scripts/doc-checks/workflow-docs-examples.ts': 1,
  'src/__tests__/agent-session-copy.test.ts': 2,
  'src/__tests__/agent-session-tool-roots.test.ts': 2,
  'src/__tests__/contribute-outcomes.test.ts': 1,
  'src/__tests__/contribute.test.ts': 2,
  'src/__tests__/default-workflows.test.ts': 1,
  'src/__tests__/desired-skills.test.ts': 1,
  'src/__tests__/e2e/benchmark-team-resources.test.ts': 2,
  'src/__tests__/e2e/benchmark-try.test.ts': 1,
  'src/__tests__/e2e/ci-extract-mr-workflow.test.ts': 1,
  'src/__tests__/e2e/copilot-global-hooks.test.ts': 1,
  'src/__tests__/e2e/copilot-pre-push-sync.test.ts': 1,
  'src/__tests__/e2e/git-exclude-doctor-915.test.ts': 1,
  'src/__tests__/e2e/import-repo-dry-run-900.test.ts': 1,
  'src/__tests__/e2e/muse-support.test.ts': 2,
  'src/__tests__/e2e/projects-manifest-crud.test.ts': 2,
  'src/__tests__/e2e/pull-resource-folders.test.ts': 1,
  'src/__tests__/e2e/push-stale-worktree-812.test.ts': 1,
  'src/__tests__/e2e/score-external-driver.test.ts': 1,
  'src/__tests__/e2e/self-improvement-guide.test.ts': 1,
  'src/__tests__/e2e/self-mode-push-behind.test.ts': 1,
  'src/__tests__/e2e/self-mode-worktrees-808.test.ts': 1,
  'src/__tests__/e2e/session-publication.test.ts': 1,
  'src/__tests__/e2e/session-to-task-1402.test.ts': 1,
  'src/__tests__/e2e/source-skills-seam-993.test.ts': 1,
  'src/__tests__/e2e/submodule-checkout-1041.test.ts': 2,
  'src/__tests__/e2e/workflow-clone-role.test.ts': 1,
  'src/__tests__/e2e/workflow-pr-delivery-1090.test.ts': 1,
  'src/__tests__/e2e/workflow-publish-resume.test.ts': 1,
  'src/__tests__/e2e/workflow-worktree-role.test.ts': 1,
  'src/__tests__/helpers/teardown-writers.ts': 1,
  'src/__tests__/mcp-folders-delivery.test.ts': 1,
  'src/__tests__/mcp-reconcile.test.ts': 2,
  'src/__tests__/recall-unreadable-config.test.ts': 1,
  'src/__tests__/scorers-cache.test.ts': 1,
  'src/__tests__/session-cli-discovery.test.ts': 1,
  'src/__tests__/session-cmd.test.ts': 3,
  'src/__tests__/session-scoring.test.ts': 1,
  'src/__tests__/session-sync.test.ts': 3,
  'src/__tests__/session-target-id.test.ts': 1,
  'src/__tests__/workflow-engine.test.ts': 1,
  'src/__tests__/workflow-scoring-evidence.test.ts': 4,
  'src/__tests__/workflow-skill-secrets.test.ts': 1,
  'src/__tests__/workflow-skill-transitions.test.ts': 1,
  'src/__tests__/workflow-worktree-role.test.ts': 3,
  'src/recall.ts': 1,
  'src/session-flow/sync.ts': 1,
}));

scopedFiles([...NOT_YET_MOVED.keys()]);

/**
 * Whether `options`, the second argument of a listing, may list recursively: `recursive` with any value but `false`, or
 * options lint cannot read, such as a variable or a spread. A string encoding, no options (`null`, `undefined`, or a
 * callback in their place) lists one folder.
 * @param {ESTree.Node | undefined} options
 * @returns {'recursive' | 'unread' | undefined}
 */
function recursionOf(options) {
  if (options === undefined || stringLiteralValue(options) !== undefined) return undefined;

  if ((options.type === 'Literal' && options.value === null) || (options.type === 'Identifier' && options.name === 'undefined')) return undefined;

  if (options.type === 'ArrowFunctionExpression' || options.type === 'FunctionExpression') return undefined;

  if (options.type === 'SpreadElement') return 'unread';

  if (options.type !== 'ObjectExpression') return 'unread';

  for (const property of options.properties) {
    if (property.type !== 'Property' || property.computed) return 'unread';
    const key = property.key.type === 'Identifier' ? property.key.name : property.key.type === 'Literal' ? String(property.key.value) : undefined;

    if (key === 'recursive' && !(property.value.type === 'Literal' && property.value.value === false)) return 'recursive';
  }

  return undefined;
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'List a folder and what is under it without following links.' },
    schema: [],
  },
  create(context) {
    const { sourceCode } = context;
    const from = repositoryPath(context).relative;
    const allowed = NOT_YET_MOVED.get(from);
    /** @type {Array<{ node: ESTree.Node, message: string }>} */
    const recursive = [];

    /**
     * Reports a listing that may be recursive at once, or, in a file NOT_YET_MOVED names, once its count is known.
     * @param {ESTree.Node} node
     * @param {string} message
     */
    const found = (node, message) => {
      if (allowed === undefined) context.report({ node, message });
      else recursive.push({ node, message });
    };

    return {
      CallExpression(node) {
        const called = fsFunctionOf(sourceCode, node.callee);

        if (called === undefined || !LISTS.has(called)) return;
        const recursion = node.arguments[0]?.type === 'SpreadElement' ? 'unread' : recursionOf(node.arguments[1]);

        if (recursion !== undefined) found(node, recursion === 'unread' ? UNREAD_MESSAGE : MESSAGE);
      },
      // A listing passed on, aliased or called through `.call`, `.apply` or `.bind` gets options lint does not see here.
      'Identifier, MemberExpression'(/** @type {ESTree.Node} */ node) {
        if (isCalled(node)) return;
        const { parent } = node;
        const isCalledThrough = parent?.type === 'MemberExpression' && parent.object === node && !parent.computed && parent.property.type === 'Identifier' && ['call', 'apply', 'bind'].includes(parent.property.name);

        if (!isCalledThrough && !refersToValue(node)) return;
        const used = fsFunctionOf(sourceCode, node);

        if (used !== undefined && LISTS.has(used)) found(node, UNREAD_MESSAGE);
      },
      'Program:exit'(node) {
        if (allowed === undefined) return;

        if (recursive.length > allowed) {
          for (const call of recursive) context.report({ node: call.node, message: `${call.message} NOT_YET_MOVED in oxlint-plugin-teamai/rules/recursive-readdir.js lets this file keep ${allowed} such calls, and it has ${recursive.length}.` });
        } else if (recursive.length < allowed) {
          context.report({ node, message: `This file lists a folder recursively fewer times than NOT_YET_MOVED in oxlint-plugin-teamai/rules/recursive-readdir.js lets it: set its count there to ${recursive.length}, or remove the file from the list at 0.` });
        }
      },
    };
  },
});
