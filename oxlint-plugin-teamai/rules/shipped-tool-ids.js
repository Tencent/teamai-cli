/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

import { isProductionSource, isScriptSource, repositoryPath, scopedFiles, stringLiteralValue } from '../utils.js';

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
  // The instances to list beside the shipped tools: one named like a shipped tool adjusts it and is listed already.
  'src/workflow/drivers/local/local-driver.ts': { count: 1 },
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

/** The tools an instance extends (`INSTANCE_BASES`), and the names their ids go by in source. */
const BASE_IDS = new Set(['claude', 'codex']);
const BASE_ID_NAMES = new Set(['CLAUDE_TOOL_ID', 'CODEX_TOOL_ID', 'CLAUDE_TOOL', 'CODEX_TOOL']);

/**
 * Files that compare a tool name with Claude Code's or Codex's id (`tool === 'codex'`, `case CODEX_TOOL_ID:`), by count,
 * from before the rule read that form. None is reviewed yet: each may leave out an instance of the tool. A comparison
 * that must hold for an instance too resolves the name with baseToolOf; one that must hold only for the shipped tool
 * raises the file's count with a comment that says why. A count above what the file holds fails until it is lowered.
 */
export const BASE_ID_COMPARISONS = new Map(Object.entries({
  'packages/tool-core/src/formats/codex.ts': 1,
  'packages/tool-core/src/stdout.ts': 3,
  'src/autocompact-reconcile.ts': 6,
  'src/builtin-hooks.ts': 1,
  'src/claude-hook-host.ts': 1,
  'src/coauthor-reconcile.ts': 5,
  'src/dashboard-collector.ts': 2,
  'src/doctor-delivery.ts': 2,
  'src/hook-fast-path.ts': 1,
  'src/hooks.ts': 36,
  'src/index.ts': 1,
  'src/init.ts': 1,
  'src/local-agent.ts': 8,
  'src/locate.ts': 1,
  'src/mcp-reconcile.ts': 10,
  'src/models/aliases.ts': 1,
  'src/models/profile.ts': 2,
  'src/models/switch.ts': 18,
  'src/pkg/commands.ts': 1,
  'src/resources/agent-format.ts': 7,
  'src/resources/mcp-format.ts': 3,
  'src/resources/skills.ts': 1,
  'src/source.ts': 1,
  'src/uninstall.ts': 3,
  'src/utils/tool-names.ts': 1,
  'src/workflow/drivers/local/local-driver.ts': 4,
  'src/workflow/drivers/local/local-tool-adapter.ts': 3,
  'src/workflow/step-model.ts': 1,
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

/**
 * Whether `node` is a call of `baseToolOf`, which resolves an instance to the tool it extends.
 * @param {ESTree.Node} node
 * @returns {boolean}
 */
function isBaseOf(node) {
  return node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'baseToolOf';
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
      },
      BinaryExpression(node) {
        if (!['===', '!==', '==', '!='].includes(node.operator) || isBaseOf(node.left) || isBaseOf(node.right)) return;

        if (isBaseId(node.left) || isBaseId(node.right)) comparisons.push(node);
      },
      SwitchCase(node) {
        if (isBaseId(node.test)) comparisons.push(node);
      },
      'Program:exit'(node) {
        if (comparisons.length > comparable) {
          for (const comparison of comparisons) {
            context.report({ node: comparison, message: 'A comparison with Claude Code\'s or Codex\'s tool id is false for an instance of that tool, so it gets none of what the comparison decides. Compare baseToolOf(tool); a check that must hold only for the shipped tool raises the file\'s count in BASE_ID_COMPARISONS in oxlint-plugin-teamai/rules/shipped-tool-ids.js, with its reason.' });
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
