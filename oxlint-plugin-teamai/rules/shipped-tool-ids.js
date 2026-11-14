/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { isProductionSource, isScriptSource, repositoryPath, scopedFiles, stringLiteralValue, variableOf } from '../utils.js';

/** The two predicates that hold only for a tool teamai ships, never for a tool instance a team or member defines. */
const SHIPPED_ONLY_PREDICATES = new Set(['isToolId', 'isAgentToolId']);

/** Where they are defined: the registry, and the registry factory it is built from. */
const DEFINITIONS = new Set(scopedFiles(['src/tool-registry.ts', 'packages/tool-core/src/registry.ts']));

/**
 * Files that still name a predicate, with how many times and why each one means only a tool teamai ships. A new
 * reference in any file fails; this list only shrinks, and a count above what the file holds fails until it is lowered.
 */
export const SHIPPED_ONLY = new Map(Object.entries({
  // A version detector runs the shipped tool's own executable; an instance may run another build, so its version is
  // unknown and its hooks stay waited.
  'src/agent-version.ts': { count: 1 },
  // A toolPaths entry replaces the default of the shipped tool it names; an instance replaces its own only through its
  // `paths`, read just before.
  'src/doctor-delivery.ts': { count: 1 },
  // Detects the shipped tools a developer uses in their home before any team config, and so any instance, is loaded.
  'src/known-agents.ts': { count: 1 },
  // A shipped tool's install gate and the leftovers of its default home that releases before #1221 wrote; and the
  // sessions channel, typed over the shipped session platforms: an instance's own store is read through `storeDirOf`
  // (src/session-flow/adapters/index.ts).
  'src/locate.ts': { count: 3 },
  // The leftovers of a shipped tool's default home that releases before #1221 wrote.
  'src/mcp-reconcile.ts': { count: 1 },
  // Refuses an instance's `extends` that names no shipped tool, before the gate on the tools instances extend, and a
  // name that takes a shipped tool's.
  'src/tool-instances.ts': { count: 3 },
  // An aliases file maps the tools teamai ships; an instance takes the entry of the tool it extends.
  'src/models/aliases.ts': { count: 1 },
  // A session variable names the shipped tool that sets it; an instance runs that tool and sets the same variable.
  'src/workflow/drivers/skill/skill-driver.ts': { count: 1 },
  // The README's tool matrix and the generated tool support page list the tools teamai ships, from their descriptors;
  // an instance is a team's or a member's, with no descriptor of its own, and the support page lists the tools it extends.
  'scripts/doc-checks/readme-matrix.ts': { count: 1 },
  'scripts/tool-support.ts': { count: 1 },
}));

scopedFiles([...SHIPPED_ONLY.keys()]);

/** The list of Codex's shipped ids, which `isCodexTool` compares with the tool an instance extends, where it is defined. */
const CODEX_ID_LIST = 'CODEX_TOOL_IDS';
const CODEX_ID_LIST_DEFINITION = new Set(scopedFiles(['src/utils/tool-names.ts']));

/** The tools an instance extends (`INSTANCE_BASES`), and the names their ids go by in source. */
const BASE_IDS = new Set(['claude', 'codex']);
const BASE_ID_NAMES = new Set(['CLAUDE_TOOL_ID', 'CODEX_TOOL_ID', 'CLAUDE_TOOL', 'CODEX_TOOL']);

/**
 * Files that compare a tool name with Claude Code's or Codex's id (`tool === 'codex'`, `case CODEX_TOOL_ID:`), by count,
 * each with why the comparison is meant to be false for an instance of that tool, or why the name it compares can never
 * be one. A comparison of what `isResolved` recognizes (the tool an instance extends, a format, a family), or a case of a
 * switch `isExhaustive` finds over a closed union, is not counted.
 * A new comparison fails; a count above what the file holds fails until it is lowered.
 */
export const BASE_ID_COMPARISONS = new Map(Object.entries({
  // The session store is ready when Codex's own executable is on PATH; an instance runs a command of its own.
  'packages/tool-core/src/formats/codex.ts': 1,
  // Every caller passes `launchAdapterIdOf(tool)`, the adapter an instance shares with its tool; the package cannot
  // import the type that says so.
  'packages/tool-core/src/stdout.ts': 3,
  // `claude` is the default of `hook --tool` (src/index.ts), which a named host replaces; an instance is never that default.
  'src/dashboard-collector.ts': 2,
  // Names the Codex build in a check's title unless it is Codex itself; an instance is named.
  'src/doctor-delivery.ts': 1,
  // The fast path runs before any instance is loaded, so it reads only the shipped name; an instance's hook takes the full
  // dispatch under Cursor or Copilot (hook-fast-path.test.ts).
  'src/hook-fast-path.ts': 1,
  // The main checkout's team hooks, Codex's team-hook dispatcher and the entry-index ownership it records are Claude
  // Code's and Codex's: an instance keeps its team hooks in its own home for each checkout (docs/guide/reference.md),
  // recorded and matched by command at both ends. The legacy manifests and host guard predate instances.
  // `--agent codex` alone reconciles Codex's team-hook dispatchers.
  'src/hooks.ts': 15,
  // `--team-hooks --tool codex` runs Codex's team-hook dispatcher, which an instance does not have (see src/hooks.ts).
  'src/index.ts': 1,
  // Iterates RELOCATABLE_TOOLS (src/types.ts), which holds only the shipped tools.
  'src/init.ts': 1,
  // OpenCode V1 reads Claude Code's own ~/.claude/CLAUDE.md, never an instance's file.
  'src/instruction-targets.ts': 1,
  // The local agent delivers models to the closed `ModelAgentKind` union; an instance gets no kind and no model.
  'src/local-agent.ts': 4,
  // tclaude and Muse Code read the project file the shipped claude target writes; an instance's target is another writer.
  'src/mcp-reconcile.ts': 1,
  // A model profile routes the `ModelAgent` tools, a closed list of shipped tools (src/models/profile.ts).
  'src/models/profile.ts': 2,
  'src/models/switch.ts': 4,
  // Asks whether a tool besides Codex writes into .agents/skills; a Codex instance pointed there is such a writer.
  'src/resources/skills.ts': 1,
  // Codex's team-hook dispatcher, which an instance does not have (see src/hooks.ts).
  'src/uninstall.ts': 2,
}));

scopedFiles([...BASE_ID_COMPARISONS.keys()]);

/**
 * Whether `node` is Claude Code's or Codex's tool id, as a string or by one of the names it goes by.
 * @param {ESTree.Node | null | undefined} node
 * @returns {boolean}
 */
function isBaseId(node) {
  const literal = stringLiteralValue(node);

  if (literal !== undefined) return BASE_IDS.has(literal);

  return node?.type === 'Identifier' && BASE_ID_NAMES.has(node.name);
}

/** String and array methods that compare their receiver, or each of its items, with their argument. */
const SEARCHES = new Set(['includes', 'startsWith', 'endsWith']);

/** Calls that answer for the tool an instance extends: its id, or the format or family it shares with that tool. */
const RESOLVERS = new Set(['baseToolOf', 'agentFormatOf', 'hookFormatOf', 'mcpFormatOf', 'launchAdapterIdOf', 'familyOf']);

/** Fields that hold such an answer, never a tool's own name: `toolOf(tool).base`, an MCP target's `format`, a descriptor's `launch`. */
const RESOLVED_FIELDS = new Set(['base', 'format', 'family', 'kind', 'launch', 'ecosystem']);

/** Types that admit only the ids teamai ships or a format, so no instance name reaches a comparison of one. */
const RESOLVED_TYPES = new Set(['ToolName', 'AgentToolId', 'ModelAgent', 'McpFormat', 'HookFormat']);

/**
 * Whether `node` holds the tool an instance extends, or a format or family, rather than a tool's own name: a resolver's
 * call, a resolved field, or a local that is never reassigned and was set from one, or a parameter typed as one.
 * @param {import('@oxlint/plugins').Context['sourceCode']} sourceCode
 * @param {ESTree.Node | null | undefined} node
 * @param {number} [depth]
 * @returns {boolean}
 */
function isResolved(sourceCode, node, depth = 0) {
  if (!node || depth > 3) return false;

  if (node.type === 'CallExpression') return node.callee.type === 'Identifier' && RESOLVERS.has(node.callee.name);

  if (node.type === 'ChainExpression') return isResolved(sourceCode, node.expression, depth);

  if (node.type === 'ConditionalExpression') return [node.consequent, node.alternate].every((branch) => isNothing(branch) || isResolved(sourceCode, branch, depth));

  if (node.type === 'MemberExpression') return !node.computed && node.property.type === 'Identifier' && RESOLVED_FIELDS.has(node.property.name);

  if (node.type !== 'Identifier') return false;
  const variable = variableOf(sourceCode, node, node.name);

  if (!variable || variable.defs.length !== 1 || variable.references.some((reference) => reference.isWrite() && !reference.init)) return false;
  const [definition] = variable.defs;

  if (definition?.type === 'Variable' && definition.node.type === 'VariableDeclarator' && definition.node.id.type === 'Identifier') {
    return isResolved(sourceCode, definition.node.init, depth + 1);
  }

  if (definition?.type !== 'Parameter' || definition.name.type !== 'Identifier') return false;
  const annotation = definition.name.typeAnnotation?.typeAnnotation;

  return isResolvedType(annotation);
}

/**
 * Whether `type` is one of `RESOLVED_TYPES`, a part of one picked with `Exclude` or `Extract`, or the type of a resolved
 * field (`AgentTool['format']`).
 * @param {ESTree.Node | null | undefined} type
 * @returns {boolean}
 */
function isResolvedType(type) {
  if (type?.type === 'TSIndexedAccessType') {
    const field = type.indexType.type === 'TSLiteralType' ? stringLiteralValue(type.indexType.literal) : undefined;

    return field !== undefined && RESOLVED_FIELDS.has(field);
  }

  if (type?.type !== 'TSTypeReference' || type.typeName.type !== 'Identifier') return false;

  if (RESOLVED_TYPES.has(type.typeName.name)) return true;

  return ['Exclude', 'Extract'].includes(type.typeName.name) && isResolvedType(type.typeArguments?.params[0]);
}

/**
 * Whether `statement` switches over a closed union: its `default` assigns the discriminant to `never`
 * (`const unhandled: never = tool;`), which the type check holds only when every member has a case, so no instance's
 * name reaches one.
 * @param {import('@oxlint/plugins').Context['sourceCode']} sourceCode
 * @param {ESTree.SwitchStatement} statement
 * @returns {boolean}
 */
function isExhaustive(sourceCode, statement) {
  const fallback = statement.cases.find((one) => one.test === null);
  const body = fallback?.consequent.flatMap((one) => (one.type === 'BlockStatement' ? one.body : [one])) ?? [];
  const discriminant = sourceCode.getText(statement.discriminant);

  return body.some((one) => one.type === 'VariableDeclaration' && one.declarations.some((declarator) => declarator.id.type === 'Identifier'
    && declarator.id.typeAnnotation?.typeAnnotation.type === 'TSNeverKeyword' && declarator.init != null && sourceCode.getText(declarator.init) === discriminant));
}

/**
 * Whether `node` is `undefined` or `null`: the branch that holds no tool at all.
 * @param {ESTree.Node} node
 * @returns {boolean}
 */
function isNothing(node) {
  return (node.type === 'Identifier' && node.name === 'undefined') || (node.type === 'Literal' && node.value === null);
}

export default defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Resolve a tool name through toolOf, so a tool instance gets the facts of the tool it extends.' },
  },
  create(context) {
    const { relative } = repositoryPath(context);

    if (!(isProductionSource(relative) || isScriptSource(relative)) || DEFINITIONS.has(relative)) return {};
    const allowed = SHIPPED_ONLY.get(relative)?.count ?? 0;
    const comparable = BASE_ID_COMPARISONS.get(relative) ?? 0;
    /** @type {Array<{ node: ESTree.Node, name: string }>} */
    const references = [];
    /** @type {ESTree.Node[]} */
    const comparisons = [];

    return {
      Identifier(node) {
        if (SHIPPED_ONLY_PREDICATES.has(node.name) && node.parent?.type !== 'ImportSpecifier') references.push({ node, name: node.name });

        // `CODEX_TOOL_IDS.some((id) => id === tool)` is a comparison with Codex's ids by another name: use isCodexTool.
        if (node.name === CODEX_ID_LIST && node.parent?.type !== 'ImportSpecifier' && !CODEX_ID_LIST_DEFINITION.has(relative)) comparisons.push(node);
      },
      BinaryExpression(node) {
        if (!['===', '!==', '==', '!='].includes(node.operator)) return;
        const other = isBaseId(node.left) ? node.right : isBaseId(node.right) ? node.left : undefined;

        if (other !== undefined && !isResolved(context.sourceCode, other)) comparisons.push(node);
      },
      // `tool.includes('codex')` and `tools.includes(CLAUDE_TOOL_ID)` compare a name, or each name in a list, as `===` does.
      CallExpression(node) {
        const { callee } = node;

        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier' || !SEARCHES.has(callee.property.name)) return;

        if (isBaseId(node.arguments[0]) && !isResolved(context.sourceCode, callee.object)) comparisons.push(node);
      },
      SwitchCase(node) {
        if (isBaseId(node.test) && node.parent?.type === 'SwitchStatement' && !isResolved(context.sourceCode, node.parent.discriminant) && !isExhaustive(context.sourceCode, node.parent)) {
          comparisons.push(node);
        }
      },
      'Program:exit'(node) {
        if (comparisons.length > comparable) {
          for (const comparison of comparisons) {
            context.report({ node: comparison, message: 'A comparison with Claude Code\'s or Codex\'s tool id is false for an instance of that tool, so it gets none of what the comparison decides. Compare baseToolOf(tool), or ask isCodexTool(tool); a check that must hold only for the shipped tool raises the file\'s count in BASE_ID_COMPARISONS in oxlint-plugin-teamai/rules/shipped-tool-ids.js, with its reason.' });
          }
        }

        if (comparisons.length < comparable) {
          context.report({ node, message: `${relative} compares a tool name with Claude Code's or Codex's id fewer times than BASE_ID_COMPARISONS allows: lower or remove its entry in oxlint-plugin-teamai/rules/shipped-tool-ids.js.` });
        }

        if (references.length > allowed) {
          for (const { node: reference, name } of references) {
            context.report({ node: reference, message: `${name} is false for a tool instance, so it gets none of the facts of the tool it extends. Resolve the name with toolOf, baseToolOf, baseDescriptorOf, agentFormatOf or toolHomeOf; a check that must hold only for a shipped tool takes a SHIPPED_ONLY entry in oxlint-plugin-teamai/rules/shipped-tool-ids.js, with its reason.` });
          }
        }

        if (references.length < allowed) {
          context.report({ node, message: `${relative} names isToolId or isAgentToolId fewer times than SHIPPED_ONLY allows: lower or remove its entry in oxlint-plugin-teamai/rules/shipped-tool-ids.js.` });
        }
      },
    };
  },
});
