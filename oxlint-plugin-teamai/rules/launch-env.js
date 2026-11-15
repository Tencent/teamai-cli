import { defineRule } from '@oxlint/plugins';
import { inProductionSource, inTestSupport, isOneOf, lintedPath, stringLiteralValue } from '../utils.js';

const LAUNCH_CONTEXT = 'Import RUN_MODE_ENV, LAUNCHED_BY_ENV or ATTEMPT_ENV from launch-context.ts instead of repeating launch variable names.';
const RUNTIME_PROTOCOL = 'Import RUN_DIR_ENV from @teamai/runtime-protocol instead of repeating launch variable names.';
const RUNTIME_PROTOCOL_FOLDER = 'Import WORKFLOW_DIR_ENV from @teamai/runtime-protocol, or from launch-context.ts, instead of repeating launch variable names.';
const RUNTIME_PACKAGE = 'A runtime package spells no TEAMAI_ variable: import the name from @teamai/runtime-protocol, and export it there first if it is new.';

/** A step runtime's own package: any but the protocol's, which owns the names runtimes may read. */
const RUNTIME_SOURCE = /\/packages\/runtime-(?!protocol\/)[^/]+\/src\//;
const TEAMAI_VARIABLE = /^TEAMAI_[A-Z0-9_]+$/;

/** Each launch variable, with the one file that spells it and what the others import instead. */
const OWNERS = new Map([
  ['TEAMAI_MODE', { file: 'src/launch-context.ts', message: LAUNCH_CONTEXT }],
  ['TEAMAI_LAUNCHED_BY', { file: 'src/launch-context.ts', message: LAUNCH_CONTEXT }],
  ['TEAMAI_WORKFLOW_ATTEMPT', { file: 'src/launch-context.ts', message: LAUNCH_CONTEXT }],
  ['TEAMAI_RUN_DIR', { file: 'packages/runtime-protocol/src/protocol.ts', message: RUNTIME_PROTOCOL }],
  ['TEAMAI_WORKFLOW_DIR', { file: 'packages/runtime-protocol/src/protocol.ts', message: RUNTIME_PROTOCOL_FOLDER }],
]);

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Keep launch environment variable spellings in the module that owns each, and out of runtime packages.' } },
  create(context) {
    // Test support builds the env a test launches with, as a test does.
    if (!inProductionSource(context) || inTestSupport(context)) return {};
    // A runtime package fails closed: it reads every teamai variable through the protocol, so a new one is caught too.
    const inRuntime = RUNTIME_SOURCE.test(lintedPath(context));

    /** @param {import('@oxlint/plugins').ESTree.Node} node @param {string} value */
    const check = (node, value) => {
      const owner = OWNERS.get(value);

      if (inRuntime && TEAMAI_VARIABLE.test(value)) context.report({ node, message: RUNTIME_PACKAGE });
      else if (owner && !isOneOf(context, [owner.file])) context.report({ node, message: owner.message });
    };

    return {
      Literal(node) {
        const value = stringLiteralValue(node);

        if (value !== undefined) check(node, value);
      },
      TemplateLiteral(node) {
        if (node.expressions.length === 0) check(node, node.quasis[0]?.value.raw ?? '');
      },
      // A name read off any object, not only process.env: a request's env or a copy of it spells the name as well.
      MemberExpression(node) {
        if (!node.computed && node.property.type === 'Identifier') check(node.property, node.property.name);
      },
      // An env built or taken apart by key, such as `{ TEAMAI_MODE: mode }` or `const { TEAMAI_MODE } = env`.
      Property(node) {
        if (!node.computed && node.key.type === 'Identifier') check(node.key, node.key.name);
      },
    };
  },
});
