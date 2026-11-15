/** @import { Context, ESTree } from '@oxlint/plugins' */
import fs from 'node:fs';
import path from 'node:path';
import { defineRule } from '@oxlint/plugins';
import { z } from 'zod';
import { FAMILY, inProductionSource, lintedPath, sourcePath, stringLiteralValue, workspaceRoot } from '../utils.js';

/** The descriptor, the one place a per-tool fact is written. */
const DESCRIPTOR = 'src/tools.ts';

/**
 * Whether `relative` is in a family package's source (`packages/tool-<family>/src/`).
 * @param {string} relative
 */
function inFamilyPackage(relative) {
  const folder = /^packages\/([^/]+)\/src\//.exec(relative)?.[1];

  return folder !== undefined && FAMILY.test(folder);
}

/** The contract tables a family declares its tools in: their descriptors, session platforms, launch profiles and version detectors. */
const FAMILY_TABLE = /^(?:Readonly<)?Record<\s*string\s*,\s*(?:ToolDescriptor|SessionPlatformDefinition|SessionPlatformFacts|LaunchAdapter|VersionDetector)\s*>>?$/;

/** The lists of every family (`BUILT_IN_TOOLS`) and of every family's facts (`BUILT_IN_FACTS`), whose keys are family names that share tool names. */
const FAMILY_LIST = /^(?:Readonly<)?Record<\s*(?:string|keyof typeof BUILT_IN_FACTS)\s*,\s*ToolFamily(?:Facts)?\s*>>?$/;

const DEFINITIONS_PACKAGE = 'packages/tool-definitions/src/';

const MESSAGE = 'Per-tool facts live in a tool family\'s descriptors (packages/tool-<family>/), read through src/tool-registry.ts. Derive this from a descriptor field, '
  + 'or key the table by every tool (Record<ToolId, ...>), so a new tool fails the type check until it is decided here.';

/** The shipped tool ids, generated from the tool registry by `node scripts/check-docs.mjs --write`. */
const TOOL_IDS_FILE = 'oxlint-plugin-teamai/tool-ids.generated.json';

const MISSING = `${TOOL_IDS_FILE} is missing or lists no tool, so teamai/tool-facts would check nothing. Run node scripts/check-docs.mjs --write.`;

const ToolIdsSchema = z.array(z.string()).min(1);

/** @type {Map<string, ReadonlySet<string> | undefined>} */
const toolIdsByRoot = new Map();

/**
 * The shipped tool ids of the checkout at `root`; undefined when the generated file is missing or empty.
 * @param {string} root
 * @returns {ReadonlySet<string> | undefined}
 */
function toolIdsAt(root) {
  if (toolIdsByRoot.has(root)) return toolIdsByRoot.get(root);
  const file = path.posix.join(root, TOOL_IDS_FILE);
  const parsed = fs.existsSync(file) ? ToolIdsSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8'))) : undefined;
  const ids = parsed?.success ? new Set(parsed.data) : undefined;
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

/**
 * Whether the table is where its tools' facts are declared: a family's contract table in its own package, or the
 * list of families in tool-definitions.
 * @param {string} relative
 * @param {readonly string[]} types
 * @returns {boolean}
 */
function declaresFamily(relative, types) {
  const pattern = inFamilyPackage(relative) ? FAMILY_TABLE : relative.startsWith(DEFINITIONS_PACKAGE) ? FAMILY_LIST : null;

  return pattern !== null && types.some((type) => pattern.test(type.trim()));
}

export default defineRule({
  meta: { type: 'problem', docs: { description: 'Keep per-tool facts in the TOOLS descriptor.' } },
  create(context) {
    if (!inProductionSource(context)) return {};
    const file = lintedPath(context);
    const root = workspaceRoot(path.posix.dirname(file)) ?? file.slice(0, file.length - sourcePath(context).length - 1);

    const relative = path.posix.relative(root, file);

    if (relative === DESCRIPTOR) return {};
    const ids = toolIdsAt(root);

    if (ids === undefined) return { Program: (node) => context.report({ node, message: MISSING }) };

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

        if (types === null || isExhaustive(types) || declaresFamily(relative, types)) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
});
