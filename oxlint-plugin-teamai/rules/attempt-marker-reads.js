import { defineRule } from '@oxlint/plugins';
import { isProductionSource, isTestSupportPath, repositoryPath, scopedFiles, stringLiteralValue } from '../utils.js';

const MESSAGE = 'Read the attempt marker through markedAttempt in src/workflow/attempt-marker.ts, which parses <run>/<attempt> once, or attemptMarker in src/launch-context.ts for its value as set. Setting it stays allowed, and so does removing it with delete or with withoutAgentEvidence in src/workflow/attempt-marker.ts; taking it apart from an env reads it.';
const SPELLING = 'TEAMAI_WORKFLOW_ATTEMPT';
const NAME = 'ATTEMPT_ENV';

/**
 * The modules that read the attempt marker off an env: the one that parses it, the one that names it, and the hook fast
 * path, which runs before the bundle loads and imports neither, so it keeps a copy of the name to test the marker is set.
 */
export const MARKER_READERS = scopedFiles(['src/workflow/attempt-marker.ts', 'src/launch-context.ts', 'src/hook-fast-path.ts']);

/**
 * Whether the rule checks `file`, relative to the repository root: production source of src/ or of any package, but
 * the marker's readers.
 * @param {string} file
 * @returns {boolean}
 */
export function isAttemptMarkerReadChecked(file) {
  return /\.[cm]?[jt]sx?$/.test(file) && isProductionSource(file) && !isTestSupportPath(file) && !MARKER_READERS.includes(file);
}

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Read the workflow attempt marker only through the module that parses it.' } },
  create(context) {
    if (!isAttemptMarkerReadChecked(repositoryPath(context).relative)) return {};
    // The marker's name and every name a module imports it under.
    const names = new Set([NAME]);

    /** @param {import('@oxlint/plugins').ESTree.Node} key @param {boolean} computed */
    const isMarker = (key, computed) => (computed
      ? (key.type === 'Identifier' && names.has(key.name)) || stringLiteralValue(key) === SPELLING
      : key.type === 'Identifier' && key.name === SPELLING);

    return {
      ImportSpecifier(node) {
        const imported = node.imported.type === 'Identifier' ? node.imported.name : stringLiteralValue(node.imported);

        if (imported === NAME) names.add(node.local.name);
      },
      // A read off any env object. Assigning or deleting the property sets the marker for a process, which is allowed.
      MemberExpression(node) {
        if (!isMarker(node.property, node.computed)) return;
        const { parent } = node;

        if (parent?.type === 'AssignmentExpression' && parent.left === node) return;

        if (parent?.type === 'UnaryExpression' && parent.operator === 'delete') return;
        context.report({ node, message: MESSAGE });
      },
      // `const { [ATTEMPT_ENV]: marker } = env` reads it too; an object literal with it as a key builds an env.
      Property(node) {
        if (node.parent?.type === 'ObjectPattern' && isMarker(node.key, node.computed)) context.report({ node, message: MESSAGE });
      },
    };
  },
});
