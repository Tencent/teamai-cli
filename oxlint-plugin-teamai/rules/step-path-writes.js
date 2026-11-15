/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { fsFunctionOf, isCalled, openKindOf, passesOnFsModule, PASSED_ON_MESSAGE, refersToValue, reExportsFsModule } from '../fs-calls.js';
import { repositoryPath, stringLiteralValue } from '../utils.js';
import { isReadChecked } from './regular-file-reads.js';
import LEFT from './step-path-writes.left.json' with { type: 'json' };

/**
 * The calls that open a path for writing whatever it holds: a FIFO there waits for a reader. A copy opens its
 * destination so; fs-extra's writers of a whole file too.
 */
const WRITES = new Set([
  'createWriteStream', 'appendFile', 'appendFileSync', 'copyFile', 'copyFileSync',
  'outputFile', 'outputFileSync', 'writeJson', 'writeJsonSync', 'writeJSON', 'writeJSONSync', 'outputJson', 'outputJsonSync', 'outputJSON', 'outputJSONSync',
]);

/** The calls that write a whole file, replacing it unless their options' `flag` only creates. */
const WHOLE_WRITES = new Set(['writeFile', 'writeFileSync']);

/** The calls that open a path, writing when their flags say so. */
const OPENS = new Set(['open', 'openSync']);

const MESSAGE = 'Write a file with writeRegularFile, appendRegularFile or openRegularFileForWrite from @teamai/shared/regular-file, or with writeJsonAtomic: a step writes the paths teamai writes to, and a FIFO it leaves there blocks a plain open for writing until a reader comes, past every deadline and past process.exit. The helper opens without blocking and refuses anything but a regular file, or a link. A create that fails on anything already there (flag wx) is allowed.';

/**
 * The plain writes each file held when the rule came to check all production source, not only `src/workflow/`, by
 * file from the repository root. A file's count only goes down: more fail as any file's do, fewer until it is lowered.
 * @type {Readonly<Record<string, number>>}
 */
const LEFT_WRITES = LEFT;

/**
 * Whether the rule checks `file`, given from the repository root: the production source the read rule checks, so a
 * new folder or package is in scope with no rule edit.
 */
export const isWriteChecked = isReadChecked;

/**
 * Whether `options`, a whole-file write's third argument, may replace what is there: anything but an object literal whose
 * `flag` is a string with `x`, which only creates and fails at once on a FIFO. What the rule cannot read replaces.
 * @param {ESTree.Node | undefined} options
 * @returns {boolean}
 */
function replacesWith(options) {
  if (options?.type !== 'ObjectExpression') return true;
  const flag = options.properties.find((property) => property.type === 'Property' && !property.computed && property.key.type === 'Identifier' && property.key.name === 'flag');
  const text = flag?.type === 'Property' ? stringLiteralValue(flag.value) : undefined;

  return text === undefined || !text.includes('x');
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Write files in production source only through the helpers that refuse a FIFO, a device or a link.' },
    // No option: the writes let off are LEFT_WRITES, which only shrinks.
    schema: [],
  },
  create(context) {
    const { relative } = repositoryPath(context);

    if (!isWriteChecked(relative)) return {};
    const { sourceCode } = context;
    const left = Object.hasOwn(LEFT_WRITES, relative) ? LEFT_WRITES[relative] ?? 0 : 0;
    /** @type {{ node: ESTree.Node; message: string }[]} */
    const found = [];

    return {
      CallExpression(node) {
        const called = fsFunctionOf(sourceCode, node.callee);

        const [, flags, options] = node.arguments;

        if (called === undefined || !(WRITES.has(called) || (WHOLE_WRITES.has(called) && replacesWith(options)) || (OPENS.has(called) && openKindOf(flags) !== 'read'))) return;
        found.push({ node, message: MESSAGE });
      },
      // A write passed on as a value, such as `.then(writeFile)`, is made by a later call whose flags the rule cannot read.
      'Identifier, MemberExpression'(/** @type {ESTree.Node} */ node) {
        if (isCalled(node) || !refersToValue(node)) return;
        const used = fsFunctionOf(sourceCode, node);

        if (used !== undefined && (WRITES.has(used) || WHOLE_WRITES.has(used) || OPENS.has(used))) found.push({ node, message: MESSAGE });
        else if (passesOnFsModule(sourceCode, node)) found.push({ node, message: PASSED_ON_MESSAGE });
      },
      'ExportNamedDeclaration, ExportAllDeclaration'(/** @type {ESTree.ExportNamedDeclaration | ESTree.ExportAllDeclaration} */ node) {
        if (reExportsFsModule(node)) found.push({ node, message: PASSED_ON_MESSAGE });
      },
      'Program:exit'(/** @type {ESTree.Program} */ node) {
        if (found.length > left) {
          for (const each of found) context.report(each);
        } else if (found.length < left) {
          context.report({ node, message: `${relative} has ${found.length} plain writes where step-path-writes.left.json lets off ${left}: lower its count there to ${found.length}, or remove it at 0.` });
        }
      },
    };
  },
});
