/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { fsFunctionOf, isCalled, openKindOf, passesOnFsModule, PASSED_ON_MESSAGE, refersToValue, reExportsFsModule } from '../fs-calls.js';
import { repositoryPath } from '../utils.js';

/**
 * The calls that open a path to read it as they find it: a read waits on a FIFO there, and a copy reads a device as a
 * file. Reads, copies, fs-extra's JSON reads, folder copies and moves (a move across filesystems is a copy), and node's
 * folder copies.
 */
const READS = new Set([
  'readFile', 'readFileSync', 'createReadStream', 'copyFile', 'copyFileSync',
  'readJson', 'readJsonSync', 'readJSON', 'readJSONSync', 'copy', 'copySync', 'cp', 'cpSync', 'move', 'moveSync',
]);

/** The calls that open a path, reading when their flags say so. */
const OPENS = new Set(['open', 'openSync']);

const MESSAGE = 'Read a file with readRegularFile or openRegularFile, and copy a file or a folder with copyRegularFile or copyRegularTree, and move one with moveRegularTree, from @teamai/shared/regular-file: a step writes the paths the engine reads, and a FIFO it leaves there blocks a plain read until a writer comes, past every deadline. The helper opens without blocking and refuses anything but a regular file.';

/**
 * Whether the rule checks `file`, given from the repository root: production source under `src/` or a package's `src/`,
 * so a new folder or package is in scope with no rule edit. Tests, `__tests__/` and `testing/` support are not.
 * @param {string} file
 * @returns {boolean}
 */
export function isReadChecked(file) {
  return /^(?:packages\/[^/]+\/)?src\/.+\.[cm]?[jt]sx?$/.test(file) && !/\.test\.[cm]?[jt]sx?$|(?:^|\/)(?:__tests__|testing)\//.test(file.replace(/^(?:packages\/[^/]+\/)?src\//, ''));
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Read files in production source only through the helper that refuses a FIFO or a device.' },
    schema: [],
  },
  create(context) {
    const { relative } = repositoryPath(context);

    if (!isReadChecked(relative)) return {};
    const { sourceCode } = context;

    return {
      // Each call is reported, as is a read passed on as a value, such as `.then(readFile)`, which a later call makes.
      CallExpression(node) {
        const called = fsFunctionOf(sourceCode, node.callee);

        if (called !== undefined && (READS.has(called) || (OPENS.has(called) && openKindOf(node.arguments[1]) !== 'write'))) context.report({ node, message: MESSAGE });
      },
      'Identifier, MemberExpression'(/** @type {ESTree.Node} */ node) {
        if (isCalled(node) || !refersToValue(node)) return;
        const used = fsFunctionOf(sourceCode, node);

        if (used !== undefined && READS.has(used)) context.report({ node, message: MESSAGE });
        else if (passesOnFsModule(sourceCode, node)) context.report({ node, message: PASSED_ON_MESSAGE });
      },
      'ExportNamedDeclaration, ExportAllDeclaration'(/** @type {ESTree.ExportNamedDeclaration | ESTree.ExportAllDeclaration} */ node) {
        if (reExportsFsModule(node)) context.report({ node, message: PASSED_ON_MESSAGE });
      },
    };
  },
});
