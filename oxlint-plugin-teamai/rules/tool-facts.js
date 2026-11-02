/** @import { Context, ESTree } from '@oxlint/plugins' */
import fs from 'node:fs';
import path from 'node:path';
import { defineRule } from '@oxlint/plugins';
import { inProductionSource, isOneOf, lintedPath, sourcePath, stringLiteralValue } from '../utils.js';

/** The descriptor, the one place a per-tool fact is written. */
const DESCRIPTOR = 'src/tools.ts';

const MESSAGE = 'Per-tool facts live in TOOLS (src/tools.ts). Derive this from a descriptor field, '
  + 'or key the table by every tool (Record<ToolId, ...>), so a new tool fails the type check until it is decided here.';

/** @type {Map<string, ReadonlySet<string>>} */
const toolIdsByRoot = new Map();

/**
 * The keys of `TOOLS` in the linted file's checkout: each `  <id>: {` line of the literal.
 * @param {Context} context
 * @returns {ReadonlySet<string>}
 */
function toolIdsFor(context) {
  const file = lintedPath(context);
  const relative = sourcePath(context);
  const root = file.slice(0, file.length - relative.length);
  const cached = toolIdsByRoot.get(root);

  if (cached) return cached;
  const descriptor = path.join(root, DESCRIPTOR);
  const source = fs.existsSync(descriptor) ? fs.readFileSync(descriptor, 'utf8') : '';
  const body = source.slice(source.indexOf('export const TOOLS = {'));
  const end = body.indexOf('\n} as const');
  const ids = new Set([...(end < 0 ? '' : body.slice(0, end)).matchAll(/^ {2}'?([a-z][a-z0-9-]*)'?: \{$/gm)].map((match) => match[1]));
  toolIdsByRoot.set(root, ids);

  return ids;
}

/**
 * The types an object literal is declared or checked against, as written, when it is a table: the
 * value of a `const`, through any `satisfies` and `as` (`as const` included). Null for an object
 * that is not a declared table, such as a value a function returns.
 * @param {ESTree.Node} node
 * @param {Context} context
 * @returns {string[] | null}
 */
function tableTypes(node, context) {
  const types = [];
  let current = node;
  let parent = node.parent;

  while (parent && (parent.type === 'TSSatisfiesExpression' || parent.type === 'TSAsExpression') && parent.expression === current) {
    types.push(context.sourceCode.getText(parent.typeAnnotation));
    current = parent;
    parent = parent.parent;
  }

  if (!parent || parent.type !== 'VariableDeclarator' || parent.init !== current) return null;

  if (parent.id.type === 'Identifier' && parent.id.typeAnnotation) types.push(context.sourceCode.getText(parent.id.typeAnnotation.typeAnnotation));

  return types;
}

/**
 * Whether one of the types keys the table by a closed union: every tool (`Record<ToolId, ...>`), or
 * another union such as an MCP format whose members share tool names. `Partial`, `string` keys, and
 * no type leave room for a tool to be missing.
 * @param {readonly string[]} types
 * @returns {boolean}
 */
function isExhaustive(types) {
  return types.some((type) => /^(?:Readonly<)?Record<\s*(?!string\s*,)/.test(type.trim()));
}

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Keep per-tool facts in the TOOLS descriptor.' } },
  create(context) {
    if (!inProductionSource(context) || isOneOf(context, [DESCRIPTOR])) return {};
    const ids = toolIdsFor(context);

    if (ids.size === 0) return {};

    /** @param {ESTree.Node | null} node */
    const toolIdOf = (node) => {
      const value = stringLiteralValue(node);

      return value !== undefined && ids.has(value);
    };

    return {
      ArrayExpression(node) {
        const named = node.elements.filter((element) => element !== null && element.type !== 'SpreadElement');

        if (named.length >= 2 && named.every(toolIdOf)) context.report({ node, message: MESSAGE });
      },
      ObjectExpression(node) {
        const keyed = node.properties.filter((property) => property.type === 'Property' && !property.computed
          && (property.key.type === 'Identifier' ? ids.has(property.key.name) : toolIdOf(property.key)));

        if (keyed.length < 2) return;
        const types = tableTypes(node, context);

        if (types !== null && !isExhaustive(types)) context.report({ node, message: MESSAGE });
      },
    };
  },
});
